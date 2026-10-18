import assert from "node:assert/strict";
import test from "node:test";
import { GraphError, createGraphClient } from "../src/graph-client.js";

function makeResponseJson(status, body, headers = {}) {
  const text = JSON.stringify(body ?? {});
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    async json() {
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
  };
}

function makeResponseBuffer(status, buffer, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    async text() {
      return buffer.toString("utf8");
    },
  };
}

test("433-retry: 429 responses retry with exponential backoff before succeeding", async () => {
  const calls = [];
  let calls2 = 0;
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url) => {
      calls.push(url.toString());
      calls2 += 1;
      if (calls2 < 3) return makeResponseJson(429, { error: { code: "tooManyRequests" } });
      return makeResponseJson(200, { value: [] });
    },
    sleepImpl: async () => {},
  });
  const result = await client.listMessages({ folderId: "inbox", top: 1 });
  assert.deepEqual(result, []);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].includes("/me/mailFolders/inbox/messages"), true);
});

test("503-retry: 5xx responses retry twice before succeeding", async () => {
  const calls = [];
  let calls2 = 0;
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => {
      calls2 += 1;
      calls.push(calls2);
      if (calls2 < 3) return makeResponseJson(503, { error: { code: "serviceUnavailable" } });
      return makeResponseJson(200, { value: [] });
    },
    sleepImpl: async () => {},
  });
  await client.listMessages({ folderId: "inbox", top: 1 });
  assert.equal(calls.length, 3);
});

test("429 with Retry-After is respected on the first retry", async () => {
  const sleepDelays = [];
  let calls2 = 0;
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => {
      calls2 += 1;
      if (calls2 === 1) {
        return makeResponseJson(
          429,
          { error: { code: "tooManyRequests" } },
          { "retry-after": "0" },
        );
      }
      return makeResponseJson(200, { value: [] });
    },
    sleepImpl: async (ms) => {
      sleepDelays.push(ms);
    },
  });
  await client.listMessages({ folderId: "inbox", top: 1 });
  assert.equal(sleepDelays.length, 1);
  assert.equal(sleepDelays[0], 0);
});

test("429 without Retry-After uses exponential backoff with a hard cap", async () => {
  const sleepDelays = [];
  let calls2 = 0;
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => {
      calls2 += 1;
      if (calls2 < 3) return makeResponseJson(429, { error: { code: "tooManyRequests" } });
      return makeResponseJson(200, { value: [] });
    },
    sleepImpl: async (ms) => {
      sleepDelays.push(ms);
    },
  });
  await client.listMessages({ folderId: "inbox", top: 1 });
  assert.equal(sleepDelays.length, 2);
  assert.ok(sleepDelays[0] > 0, `first backoff must be > 0, got ${sleepDelays[0]}`);
  assert.ok(sleepDelays[1] >= sleepDelays[0], "second backoff must be >= first");
  assert.ok(sleepDelays[1] <= 8_000, `backoff must be capped at 8000ms, got ${sleepDelays[1]}`);
});

test("persistent 429 throws GraphError that carries status, url, and method", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => makeResponseJson(429, { error: { code: "tooManyRequests" } }),
    sleepImpl: async () => {},
  });
  await assert.rejects(
    () => client.listMessages({ folderId: "inbox", top: 1 }),
    (error) => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.status, 429);
      assert.equal(error.method, "GET");
      assert.match(error.url, /\/me\/mailFolders\/inbox\/messages/);
      // The error message must NOT echo any Microsoft Graph body text.
      assert.equal(error.message.includes("tooManyRequests"), false);
      return true;
    },
  );
});

test("persistent 503 throws GraphError that carries status, url, and method", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => makeResponseJson(503, { error: { code: "serviceUnavailable" } }),
    sleepImpl: async () => {},
  });
  await assert.rejects(
    () => client.listMessages({ folderId: "inbox", top: 1 }),
    (error) => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.status, 503);
      assert.equal(error.method, "GET");
      return true;
    },
  );
});

test("attachment $value: 401 refreshes token once and retries", async () => {
  const calls = [];
  const tokenCalls = [];
  const client = createGraphClient({
    getAccessToken: async (options = {}) => {
      tokenCalls.push(options);
      return options.forceRefresh ? "token-b" : "token-a";
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), auth: init.headers.authorization });
      if (calls.length === 1) return makeResponseBuffer(401, Buffer.from("denied"));
      return makeResponseBuffer(
        200,
        Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(16, 0)]),
      );
    },
  });
  const buffer = await client.getAttachmentRawContent("msg-1", "att-1");
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.length > 9, true);
  assert.equal(calls[0].auth, "Bearer token-a");
  assert.equal(calls[1].auth, "Bearer token-b");
  assert.deepEqual(tokenCalls.slice(0, 2), [{ forceRefresh: false }, { forceRefresh: true }]);
});

test("attachment $value: 429 retry succeeds before max attempts", async () => {
  const sleeps = [];
  let calls2 = 0;
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => {
      calls2 += 1;
      if (calls2 < 2) return makeResponseBuffer(429, Buffer.alloc(0));
      return makeResponseBuffer(
        200,
        Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(8, 0)]),
      );
    },
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  const buffer = await client.getAttachmentRawContent("msg-1", "att-1");
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(sleeps.length, 1);
});

test("attachment $value: persistent 429 throws GraphError with status/method/url", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => makeResponseBuffer(429, Buffer.alloc(0)),
    sleepImpl: async () => {},
  });
  await assert.rejects(
    () => client.getAttachmentRawContent("msg-1", "att-1"),
    (error) => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.status, 429);
      assert.equal(error.method, "GET");
      assert.match(error.url, /\/me\/messages\/msg-1\/attachments\/att-1\/\$value$/);
      return true;
    },
  );
});

test("4xx responses (non-429) are not retried", async () => {
  let calls2 = 0;
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => {
      calls2 += 1;
      return makeResponseJson(404, { error: { code: "notFound" } });
    },
    sleepImpl: async () => {
      throw new Error("must not sleep on a 4xx that is not 401 or 429");
    },
  });
  await assert.rejects(
    () => client.listMessages({ folderId: "inbox", top: 1 }),
    (error) => error instanceof GraphError && error.status === 404,
  );
  assert.equal(calls2, 1);
});
