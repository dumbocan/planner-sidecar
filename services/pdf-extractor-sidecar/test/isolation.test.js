import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Compose isolates the PDF extractor from the host, blocks external networks, and never mounts tokens or secrets", async () => {
  const compose = await text("docker-compose2.yml");
  const block =
    compose.match(/  pdf-extractor-sidecar:[\s\S]*?(?=\n  [a-z][^\n]+:|\nnetworks:)/)?.[0] ?? "";
  assert.ok(block, "pdf-extractor-sidecar service block missing from docker-compose2.yml");
  assert.match(block, /image:\s+pdf-extractor-sidecar:local/);
  assert.match(block, /read_only: true/);
  assert.match(block, /cap_drop:\s*\n\s*- ALL/);
  assert.match(block, /no-new-privileges:true/);
  assert.match(block, /pdf-mcp-internal/);
  assert.match(block, /tmpfs:/);
  assert.doesNotMatch(block, /\n\s*ports:/);
  // The extractor must never see the Outlook token cache or any host secret dir.
  assert.doesNotMatch(block, /outlook-state/);
  assert.doesNotMatch(block, /secrets:/);
});

test("Compose declares pdf-mcp-internal as an internal-only network", async () => {
  const compose = await text("docker-compose2.yml");
  const block =
    compose.match(/  pdf-mcp-internal:[\s\S]*?(?=\n  [a-z][^\n]+:|\s*$)/)?.[0] ?? "";
  assert.ok(block.length > 0, "pdf-mcp-internal network block missing from docker-compose2.yml");
  assert.match(block, /internal: true/);
});

test("Dockerfile builds from a pinned Node 22.22.3+ base image and runs as non-root", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^FROM\s+node:(\d+)\.(\d+)\.(\d+)/m);
  const match = dockerfile.match(/^FROM\s+node:(\d+)\.(\d+)\.(\d+)/m);
  const [, major, minor, patch] = match;
  const version = Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch);
  const minimum = 22 * 1_000_000 + 22 * 1_000 + 3;
  assert.ok(version >= minimum, `Dockerfile base image must be >= 22.22.3, found ${major}.${minor}.${patch}`);
  assert.match(dockerfile, /^USER\s+node/m);
});

test("source has no filesystem writes or persistent state", async () => {
  const extractSrc = await readFile(new URL("../src/extract.js", import.meta.url), "utf8");
  const serverSrc = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(extractSrc, /writeFile|mkdir|appendFile|createWriteStream/);
  assert.doesNotMatch(serverSrc, /writeFile|mkdir|appendFile|createWriteStream/);
  // PDF extractor must not import anything that talks to Graph, MSAL, or any auth provider.
  assert.doesNotMatch(serverSrc, /@azure|msal|graph\.microsoft\.com|login\.microsoftonline\.com/i);
  assert.doesNotMatch(extractSrc, /@azure|msal|graph\.microsoft\.com|login\.microsoftonline\.com/i);
});