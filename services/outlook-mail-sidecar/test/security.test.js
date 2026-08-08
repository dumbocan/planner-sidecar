import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTokenCachePath } from "../src/auth.js";

test("token cache is sidecar-local and mode 0600", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-test-"));
  const cachePath = await ensureTokenCachePath(root);
  const cacheStat = await stat(cachePath);
  assert.equal(cachePath, path.join(root, "token-cache.json"));
  assert.equal(cacheStat.mode & 0o777, 0o600);
});

test("source has no mutation-capable Graph methods", async () => {
  const source = await readFile(new URL("../src/graph-client.js", import.meta.url), "utf8");
  // The sidecar must never use a write HTTP verb against Graph. Attachment
  // reads still use GET only.
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PATCH|PUT|DELETE)/);
  // Mutation endpoints are forbidden. The reader.cancel() call we use to abort
  // an oversized stream is a Node stream API, not a Graph endpoint, so we look
  // for write-style Graph path segments instead.
  assert.doesNotMatch(
    source,
    /\/(?:sendMail|move|delete|update|reply|forward|cancel)\b/i,
  );
});

test("source never logs raw attachment bytes, message IDs, or attachment IDs", async () => {
  const source = await readFile(new URL("../src/graph-client.js", import.meta.url), "utf8");
  // No console / logger / structured event payload may include a message ID,
  // attachment ID, attachment name, or buffer field name. The Graph error
  // envelopes intentionally never echo those values.
  assert.doesNotMatch(source, /console\.(log|info|warn|error)\s*\(/);
  // JSON.stringify payloads that go to stderr must not include those keys.
  const logPayloads = source.match(/JSON\.stringify\([^)]+\)/g) ?? [];
  for (const payload of logPayloads) {
    assert.doesNotMatch(payload, /\b(messageId|attachmentId|messageBytes|attachmentBytes|contentBytes|attachmentName|messageBytes|buffer)\b/);
  }
});

test("Docker base image uses Node version at or above the repository minimum (22.22.3)", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const match = dockerfile.match(/FROM\s+node:(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, "Dockerfile should pin a node base image");
  const [, major, minor, patch] = match;
  const version = Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch);
  const minimum = 22 * 1_000_000 + 22 * 1_000 + 3;
  assert.ok(
    version >= minimum,
    `Dockerfile base image must be >= 22.22.3, found ${major}.${minor}.${patch}`,
  );
});
