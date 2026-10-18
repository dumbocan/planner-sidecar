#!/usr/bin/env node
// Download Mercadona invoice PDFs from the local Outlook sidecar.
// Reads MCP traffic over streamable HTTP directly — no SDK dependency.
//
// Usage:
//   node services/outlook-mail-sidecar/scripts/extract-mercadona.mjs
//   node services/outlook-mail-sidecar/scripts/extract-mercadona.mjs --query mercadona --limit 30
//   node services/outlook-mail-sidecar/scripts/extract-mercadona.mjs --mcp-url http://outlook-mail-sidecar:3000/mcp --out-dir attachments/mercadona

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_MCP_URL = "http://outlook-mail-sidecar:3000/mcp";
const DEFAULT_QUERY = "mercadona";
const DEFAULT_LIMIT = 30;
const DEFAULT_OUT_DIR = "attachments/mercadona";

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

const MCP_URL = getArg("--mcp-url", DEFAULT_MCP_URL);
const QUERY = getArg("--query", DEFAULT_QUERY);
const LIMIT = Number(getArg("--limit", DEFAULT_LIMIT));
const OUT_DIR = getArg("--out-dir", DEFAULT_OUT_DIR);
const DRY_RUN = args.includes("--dry-run");

const STATE_DIR = process.env.OUTLOOK_STATE_DIR ?? "./outlook-state";

function log(level, msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] ${level} ${msg}\n`);
}

// Streamable HTTP MCP client — minimal, no SDK.
class Mcp {
  constructor(url) {
    this.url = url;
    this.sessionId = null;
    this.requestId = 1;
  }

  async #rpc(method, params) {
    const id = this.requestId++;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const res = await fetch(this.url, { method: "POST", headers, body });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const text = await res.text();
    let payload = null;
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {}
      }
    }
    if (!payload) {
      throw new Error(`mcp: empty response for ${method} (status ${res.status})`);
    }
    if (payload.error) {
      throw new Error(`mcp ${method}: ${payload.error.message ?? JSON.stringify(payload.error)}`);
    }
    return payload.result;
  }

  async initialize() {
    const result = await this.#rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "extract-mercadona", version: "0.1.0" },
    });
    await this.#rpc("notifications/initialized", {}).catch(() => {});
    return result;
  }

  async callTool(name, args) {
    const result = await this.#rpc("tools/call", { name, arguments: args });
    const content = Array.isArray(result?.content) ? result.content : [];
    if (result?.isError) {
      const text = content.map((c) => c.text ?? "").join(" ");
      throw new Error(`tool ${name} failed: ${text}`);
    }
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        try {
          return JSON.parse(block.text);
        } catch {
          return block.text;
        }
      }
    }
    return null;
  }
}

async function loadSeenHashes(file) {
  const map = new Map();
  try {
    const fs = await import("node:fs/promises");
    const entries = await fs.readFile(file, { encoding: "utf8" });
    for (const line of entries.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const { hash, savedPath } = JSON.parse(trimmed);
        map.set(hash, savedPath);
      } catch {}
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return map;
}

async function appendSeenHash(file, hash, savedPath) {
  const line = JSON.stringify({ hash, savedPath }) + "\n";
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(file, { flags: "a", mode: 0o600 });
    stream.write(line, (err) => (err ? reject(err) : resolve()));
    stream.end();
  });
}

async function main() {
  const seenFile = path.resolve(process.cwd(), "outlook-attachments-seen.jsonl");
  const seen = await loadSeenHashes(seenFile);

  log("INFO", `mcp=${MCP_URL} query=${JSON.stringify(QUERY)} limit=${LIMIT} outDir=${OUT_DIR} dryRun=${DRY_RUN}`);
  const mcp = new Mcp(MCP_URL);
  await mcp.initialize();
  log("INFO", "mcp session initialized");

  const search = await mcp.callTool("outlook_search_messages", {
    query: QUERY,
    limit: LIMIT,
  });
  if (!Array.isArray(search)) {
    throw new Error(`search returned non-array: ${JSON.stringify(search).slice(0, 200)}`);
  }
  log("INFO", `search returned ${search.length} messages`);
  if (search.length === 0) {
    log("WARN", "no messages matched; check query or limit");
    return;
  }

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const message of search) {
    const messageId = message?.messageId;
    if (!messageId) continue;
    let pdfs;
    try {
      pdfs = await mcp.callTool("outlook_list_pdf_attachments", { messageId });
    } catch (error) {
      log("ERROR", `listPdfAttachments ${messageId}: ${error.message}`);
      failed += 1;
      continue;
    }
    if (!Array.isArray(pdfs) || pdfs.length === 0) continue;
    for (const pdf of pdfs) {
      const attachmentId = pdf?.attachmentId;
      if (!attachmentId) continue;
      const stamp = `${messageId}/${attachmentId}`;
      if (DRY_RUN) {
        log("DRY", `would save ${stamp} (${pdf?.name}, ${pdf?.size} bytes)`);
        downloaded += 1;
        continue;
      }
      try {
        const result = await mcp.callTool("outlook_save_pdf_attachment", {
          messageId,
          attachmentId,
          confirm: true,
          outDir: OUT_DIR,
        });
        const savedPath = result?.savedPath;
        const hash = result?.sha256;
        if (!savedPath || !hash) throw new Error("missing savedPath or sha256 in result");
        if (seen.has(hash)) {
          log("INFO", `skip duplicate ${stamp} (already at ${seen.get(hash)})`);
          skipped += 1;
        } else {
          seen.set(hash, savedPath);
          await appendSeenHash(seenFile, hash, savedPath);
          log("INFO", `saved ${stamp} -> ${savedPath} (${result.size} bytes, hash=${hash.slice(0, 12)}…)`);
          downloaded += 1;
        }
      } catch (error) {
        log("ERROR", `savePdfAttachment ${stamp}: ${error.message}`);
        failed += 1;
      }
    }
  }

  log("INFO", `done downloaded=${downloaded} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  log("ERROR", error.stack ?? error.message);
  process.exit(1);
});
