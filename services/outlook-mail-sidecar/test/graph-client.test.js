import assert from "node:assert/strict";
import test from "node:test";
import { createGraphClient } from "../src/graph-client.js";

test("recursively includes child folders such as Junk Email", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "test-token",
    baseUrl: "https://graph.test/v1.0",
    fetchImpl: async (url) => {
      const body = url.pathname.endsWith("/childFolders")
        ? { value: [{ id: "junk", displayName: "Junk Email", childFolderCount: 0 }] }
        : { value: [{ id: "parent", displayName: "Mailbox", childFolderCount: 1 }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const folders = await client.listFolders();
  assert.deepEqual(
    folders.map((folder) => folder.displayName),
    ["Mailbox", "Junk Email"],
  );
});
test("Graph client only creates GET requests for the Outlook read surface", async () => {
  const requests = [];
  const client = createGraphClient({
    getAccessToken: async () => "test-token",
    baseUrl: "https://graph.test/v1.0",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.listFolders();
  await client.listMessages({ folderId: "inbox", top: 2 });
  await client.getMessage("message");

  assert.ok(requests.length >= 3);
  assert.ok(requests.every(({ options }) => options.method === "GET"));
  assert.ok(requests.every(({ options }) => options.body === undefined));
});

test("bounds Graph response bytes before JSON parsing and surfaces a generic safe error", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "test-token",
    baseUrl: "https://graph.test/v1.0",
    fetchImpl: async () => {
      const huge = '{"value":[{"id":"' + "x".repeat(6 * 1024 * 1024) + '"}]}';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(huge));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(
    () => client.listMessages({ top: 1 }),
    (error) => {
      assert.equal(error?.name, "GraphError");
      assert.ok(
        /too large|exceeded|unavailable/i.test(error.message),
        `expected generic safe error, got: ${error.message}`,
      );
      assert.ok(
        !error.message.includes("x".repeat(64)),
        "error message must not echo payload bytes",
      );
      return true;
    },
  );
});

test("listMessageAttachments fetches attachment metadata with a bounded $select", async () => {
  const requests = [];
  const client = createGraphClient({
    getAccessToken: async () => "test-token",
    baseUrl: "https://graph.test/v1.0",
    fetchImpl: async (url) => {
      requests.push({ url: url.toString(), method: "GET" });
      return new Response(
        JSON.stringify({
          value: [
            {
              id: "att-1",
              name: "doc.pdf",
              contentType: "application/pdf",
              size: 1024,
              isInline: false,
              "@odata.type": "#microsoft.graph.fileAttachment",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const rows = await client.listMessageAttachments("msg-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "att-1");
  assert.match(requests[0].url, /\/me\/messages\/msg-1\/attachments\?/);
  assert.match(
    requests[0].url,
    /%24select=id%2Cname%2CcontentType%2Csize%2CisInline/,
  );
  assert.match(requests[0].url, /%24top=50/);
});

test("getAttachmentRawContent fetches $value and bounds the response buffer", async () => {
  const requests = [];
  const client = createGraphClient({
    getAccessToken: async () => "test-token",
    baseUrl: "https://graph.test/v1.0",
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), method: options?.method });
      return new Response(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(32, 0)]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    },
  });

  const buffer = await client.getAttachmentRawContent("msg-1", "att-1");
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.length, 32 + 9);
  assert.equal(requests[0].method, "GET");
  assert.match(requests[0].url, /\/me\/messages\/msg-1\/attachments\/att-1\/\$value$/);
});

test("getAttachmentRawContent rejects oversized attachments before buffering them", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "test-token",
    baseUrl: "https://graph.test/v1.0",
    fetchImpl: async () => {
      const oversized = Buffer.alloc(13 * 1024 * 1024, "x");
      return new Response(oversized, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": String(oversized.length) },
      });
    },
  });

  await assert.rejects(
    () => client.getAttachmentRawContent("msg-1", "att-1"),
    (error) => {
      assert.equal(error?.name, "GraphError");
      assert.match(error.message, /unavailable/);
      assert.ok(!error.message.includes("x".repeat(32)));
      return true;
    },
  );
});
