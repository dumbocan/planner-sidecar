import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { readBoundedJsonBody, MAX_MCP_REQUEST_BODY_BYTES } from "../src/http-bound.js";

function streamFrom(chunks) {
  return Readable.from(chunks);
}

test("parses a small request body within the bound", async () => {
  const request = streamFrom([Buffer.from('{"method":"ping"}')]);
  const result = await readBoundedJsonBody(request, MAX_MCP_REQUEST_BODY_BYTES);
  assert.deepEqual(result, { method: "ping" });
});

test("returns undefined for an empty body without exceeding the bound", async () => {
  const request = streamFrom([]);
  const result = await readBoundedJsonBody(request, MAX_MCP_REQUEST_BODY_BYTES);
  assert.equal(result, undefined);
});

test("rejects a single oversized chunk before JSON parsing", async () => {
  const request = streamFrom([Buffer.alloc(MAX_MCP_REQUEST_BODY_BYTES + 1, "x")]);
  await assert.rejects(
    () => readBoundedJsonBody(request, MAX_MCP_REQUEST_BODY_BYTES),
    (error) => {
      assert.match(error?.message ?? "", /too large/i);
      assert.ok(
        !error.message.includes("x".repeat(64)),
        "error message must not echo payload bytes",
      );
      return true;
    },
  );
});

test("rejects accumulated chunks that cross the bound before JSON parsing", async () => {
  const chunk = Buffer.alloc(MAX_MCP_REQUEST_BODY_BYTES / 2, "y");
  const request = streamFrom([chunk, chunk, Buffer.alloc(MAX_MCP_REQUEST_BODY_BYTES, "z")]);
  await assert.rejects(
    () => readBoundedJsonBody(request, MAX_MCP_REQUEST_BODY_BYTES),
    /too large/i,
  );
});
