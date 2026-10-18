import assert from "node:assert/strict";
import test from "node:test";
import { GraphError } from "../src/graph-client.js";
import { failure, GENERIC_ERROR_TEXT, GRAPH_ERROR_MESSAGES } from "../src/server.js";

async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk === "string") lines.push(chunk);
    else if (chunk instanceof Uint8Array) lines.push(Buffer.from(chunk).toString("utf8"));
    return original(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

function findFailureEvent(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.event === "outlook_tool_failure") return parsed;
    } catch {
      // Skip non-JSON stderr lines.
    }
  }
  return null;
}

function graphError(status, method, url) {
  return new GraphError("Outlook request failed", { status, method, url });
}

test("failure() logs status, method, and url for a 429 so a Mercadona batch is recoverable", async () => {
  const lines = await captureStderr(() => {
    failure(
      "outlook_list_pdf_attachments",
      graphError(429, "GET", "https://graph.microsoft.com/v1.0/me/messages/abc/attachments"),
    );
  });
  const event = findFailureEvent(lines);
  assert.ok(event, "expected an outlook_tool_failure log entry");
  assert.equal(event.tool, "outlook_list_pdf_attachments");
  assert.equal(event.error, "GraphError");
  assert.equal(event.status, 429);
  assert.equal(event.method, "GET");
  assert.match(event.url, /graph\.microsoft\.com/);
});

test("failure() logs status 503 for transient outages", async () => {
  const lines = await captureStderr(() => {
    failure(
      "outlook_extract_pdf_attachment",
      graphError(503, "GET", "https://graph.microsoft.com/v1.0/me/messages/m/attachments/a/$value"),
    );
  });
  const event = findFailureEvent(lines);
  assert.ok(event);
  assert.equal(event.status, 503);
  assert.equal(event.tool, "outlook_extract_pdf_attachment");
});

test("failure() returns a 429-aware message so the LLM can pace retries", async () => {
  const lines = await captureStderr(() => {
    const result = failure(
      "outlook_list_pdf_attachments",
      graphError(429, "GET", "https://graph.microsoft.com/v1.0/me/messages/m/attachments"),
    );
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, GRAPH_ERROR_MESSAGES[429]);
    assert.notEqual(result.content[0].text, GENERIC_ERROR_TEXT);
  });
  assert.ok(findFailureEvent(lines));
});

test("failure() returns a 503-aware message", async () => {
  await captureStderr(() => {
    const result = failure(
      "outlook_extract_pdf_attachment",
      graphError(503, "GET", "https://graph.microsoft.com/v1.0/me/messages/m/attachments/a/$value"),
    );
    assert.equal(result.content[0].text, GRAPH_ERROR_MESSAGES[503]);
  });
});

test("failure() returns a 401-aware message so the LLM does not loop forever", async () => {
  await captureStderr(() => {
    const result = failure(
      "outlook_list_messages",
      graphError(401, "GET", "https://graph.microsoft.com/v1.0/me/messages"),
    );
    assert.equal(result.content[0].text, GRAPH_ERROR_MESSAGES[401]);
  });
});

test("failure() returns the generic message for unknown error kinds", async () => {
  const lines = await captureStderr(() => {
    const result = failure("outlook_list_folders", new Error("boom"));
    assert.equal(result.content[0].text, GENERIC_ERROR_TEXT);
    assert.equal(result.isError, true);
  });
  const event = findFailureEvent(lines);
  assert.ok(event);
  assert.equal(event.status, null);
  assert.equal(event.method, null);
  assert.equal(event.url, null);
});

test("failure() never includes token, body, or attachment bytes in the log", async () => {
  const lines = await captureStderr(() => {
    failure(
      "outlook_extract_pdf_attachment",
      graphError(500, "GET", "https://graph.microsoft.com/v1.0/me/messages/m/attachments/a/$value"),
    );
  });
  // The log only carries request coordinates; no token, no body, no filename.
  // The URL path is logged (including "$value") because it is the actual
  // Graph endpoint and contains no secrets. We must NOT leak bearer tokens,
  // JWT-like prefixes, or attachment filenames.
  const serialized = JSON.stringify(lines);
  assert.equal(serialized.includes("Bearer"), false);
  assert.equal(serialized.includes("eyJ"), false, "must not leak JWT-like prefixes");
  assert.equal(serialized.includes("factura"), false);
  assert.equal(serialized.includes("A-G2026"), false);
  assert.equal(serialized.includes("Authorization"), false);
});
