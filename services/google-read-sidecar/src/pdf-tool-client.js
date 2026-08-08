// Internal MCP client for the PDF tool sidecar. The Google read sidecar acts as
// an MCP client (to pdf-tool-sidecar) while remaining an MCP server itself (to
// the gateway). This client manages the StreamableHTTP session lifecycle lazily:
// the first extract() call initializes a session and caches the mcp-session-id
// header for reuse on subsequent calls. If a tools/call receives a 404
// (session expired), it re-initializes and retries once.

const DEFAULT_URL = "http://pdf-tool-sidecar:3000/mcp";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const PDF_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_CALL_ATTEMPTS = 2;
const MCP_CLIENT_INFO = { name: "google-read-sidecar", version: "0.1.0" };

export const PDF_TOOL_DEFAULT_URL = DEFAULT_URL;
export const PDF_TOOL_TIMEOUT = PDF_TOOL_TIMEOUT_MS;

export class PdfToolError extends Error {
  constructor(message, code = "pdf_tool_unavailable") {
    super(message);
    this.name = "PdfToolError";
    this.code = code;
  }
}

export function createPdfToolClient({
  url = process.env.PDF_TOOL_URL || DEFAULT_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = PDF_TOOL_TIMEOUT_MS,
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");

  let sessionId = null;
  let negotiatedProtocolVersion = protocolVersion;
  let nextId = 0;

  function buildHeaders() {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
      headers["mcp-protocol-version"] = negotiatedProtocolVersion;
    }
    return headers;
  }

  async function post(message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new PdfToolError("pdf-tool request timed out", "pdf_tool_timeout");
      }
      throw new PdfToolError("pdf-tool is unreachable", "pdf_tool_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  function parseSse(text) {
    const events = text.split(/\n\s*\n/);
    for (const eventBlock of events) {
      const lines = eventBlock.split(/\r?\n/);
      let data = "";
      let hasData = false;
      for (const line of lines) {
        if (line.startsWith("data:")) {
          hasData = true;
          let value = line.slice(5);
          if (value.startsWith(" ")) value = value.slice(1);
          data = data ? data + "\n" + value : value;
        }
      }
      if (hasData && data) {
        try {
          return JSON.parse(data);
        } catch {
          throw new PdfToolError("Failed to parse SSE data as JSON", "pdf_tool_invalid_response");
        }
      }
    }
    throw new PdfToolError("No data in SSE response", "pdf_tool_invalid_response");
  }

  async function readJsonRpc(response) {
    if (!response.ok) {
      if (response.status === 404) {
        throw new PdfToolError("pdf-tool session expired", "pdf_tool_session_expired");
      }
      const text = await response.text().catch(() => "");
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore parse error */ }
      const code =
        typeof parsed?.error?.code === "number"
          ? parsed.error.code.toString()
          : "pdf_tool_invalid_response";
      const msg = parsed?.error?.message ?? `pdf-tool rejected the request (${response.status})`;
      throw new PdfToolError(msg, code);
    }
    const text = await response.text();
    const contentType = response.headers?.get?.("content-type");
    let payload;
    if (contentType?.includes("text/event-stream")) {
      payload = parseSse(text);
    } else if (contentType?.includes("application/json")) {
      try { payload = JSON.parse(text); }
      catch { throw new PdfToolError("pdf-tool returned non-JSON response", "pdf_tool_invalid_response"); }
    } else {
      try { payload = JSON.parse(text); }
      catch {
        try { payload = parseSse(text); }
        catch { throw new PdfToolError("pdf-tool returned an unparseable response", "pdf_tool_invalid_response"); }
      }
    }
    if (payload.error) {
      throw new PdfToolError(
        payload.error.message ?? "pdf-tool returned a JSON-RPC error",
        typeof payload.error.code === "number"
          ? payload.error.code.toString()
          : "pdf_tool_invalid_response",
      );
    }
    return payload;
  }

  async function initialize() {
    sessionId = null;
    const message = {
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
    };
    const response = await post(message);
    const newSessionId = response.headers?.get?.("mcp-session-id");
    if (newSessionId) sessionId = newSessionId;
    const payload = await readJsonRpc(response);
    if (payload.result?.protocolVersion) {
      negotiatedProtocolVersion = payload.result.protocolVersion;
    }
    return payload;
  }

  async function ensureSession() {
    if (!sessionId) {
      await initialize();
    }
  }

  function isSessionExpired(error) {
    return error instanceof PdfToolError && error.code === "pdf_tool_session_expired";
  }

  async function callTool(toolName, args) {
    for (let attempt = 0; attempt < MAX_TOOL_CALL_ATTEMPTS; attempt++) {
      await ensureSession();
      const message = {
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      };
      try {
        const response = await post(message);
        return await readJsonRpc(response);
      } catch (error) {
        if (attempt < MAX_TOOL_CALL_ATTEMPTS - 1 && isSessionExpired(error)) {
          sessionId = null;
          continue;
        }
        throw error;
      }
    }
    throw new PdfToolError("pdf-tool call failed after retries", "pdf_tool_unavailable");
  }

  async function extract({ data, maxChars, maxPages, name }) {
    if (typeof data !== "string" || data.length === 0) {
      throw new PdfToolError("pdf-tool request must include data", "pdf_tool_malformed_request");
    }
    const args = { data };
    if (typeof name === "string" && name.length > 0) args.name = name;
    if (typeof maxChars === "number") args.maxChars = maxChars;
    if (typeof maxPages === "number") args.maxPages = maxPages;

    const payload = await callTool("extract_pdf_from_base64", args);
    const result = payload?.result;
    if (!result || !Array.isArray(result.content) || result.content.length === 0) {
      throw new PdfToolError("pdf-tool returned no content", "pdf_tool_invalid_response");
    }
    const textContent = result.content[0];
    if (textContent?.type !== "text" || typeof textContent?.text !== "string") {
      throw new PdfToolError("pdf-tool returned unexpected content format", "pdf_tool_invalid_response");
    }
    try {
      return JSON.parse(textContent.text);
    } catch {
      throw new PdfToolError("pdf-tool returned non-JSON text content", "pdf_tool_invalid_response");
    }
  }

  return {
    url,
    extract,
  };
}
