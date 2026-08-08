import assert from "node:assert/strict";
import test from "node:test";
import { createPdfToolClient, PdfToolError, PDF_TOOL_DEFAULT_URL } from "../src/pdf-tool-client.js";

function sseResponse(status, jsonRpc, sessionId) {
  const headers = { "content-type": "text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const body = `event: message\ndata: ${JSON.stringify(jsonRpc)}\n\n`;
  return new Response(body, { status, headers });
}

function jsonResponse(status, jsonRpc, sessionId) {
  const headers = { "content-type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return new Response(JSON.stringify(jsonRpc), { status, headers });
}

function sseInitializeResponse(id, sessionId) {
  return sseResponse(200, {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: { name: "pdf-tool-sidecar", version: "0.1.0" },
    },
  }, sessionId);
}

function sseToolsCallResponse(id, textContent) {
  const text = typeof textContent === "string" ? textContent : JSON.stringify(textContent);
  return sseResponse(200, {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
    },
  });
}

test("extract posts an initialize then a tools/call and returns the parsed JSON object", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    const body = JSON.parse(options.body);
    if (body.method === "initialize") {
      return sseInitializeResponse(body.id, "sess-123");
    }
    if (body.method === "tools/call") {
      assert.equal(body.params.name, "extract_pdf_from_base64");
      assert.equal(body.params.arguments.data, "AAA=");
      assert.equal(body.params.arguments.maxChars, 10000);
      assert.equal(body.params.arguments.maxPages, 20);
      assert.equal(body.params.arguments.name, "factura.pdf");
      return sseToolsCallResponse(body.id, {
        text: "Hello PDF",
        pages: 1,
        truncated: false,
        invoiceFields: null,
        lineItems: [],
        parser: "plain-text",
        parserStats: { lineItemsDetected: 0 },
        size: 1024,
        sha256: "abc123",
        path: null,
        name: "factura.pdf",
        trustBoundary: "test-boundary",
      });
    }
    return new Response(null, { status: 404 });
  };

  const client = createPdfToolClient({ url: "http://pdf-tool-sidecar:3000/mcp", fetchImpl });
  const result = await client.extract({
    data: "AAA=",
    maxChars: 10000,
    maxPages: 20,
    name: "factura.pdf",
  });

  assert.equal(result.text, "Hello PDF");
  assert.equal(result.pages, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.invoiceFields, null);
  assert.deepEqual(result.lineItems, []);
  assert.equal(result.parser, "plain-text");
  assert.equal(result.size, 1024);
  assert.equal(result.sha256, "abc123");
  assert.equal(result.name, "factura.pdf");

  // First call: initialize (no session-id header)
  assert.equal(calls[0].body.method, "initialize");
  assert.equal(calls[0].headers["mcp-session-id"], undefined);
  // Second call: tools/call (with session-id header)
  assert.equal(calls[1].body.method, "tools/call");
  assert.equal(calls[1].headers["mcp-session-id"], "sess-123");
});

test("extract uses the default URL when no url option is passed", async () => {
  let capturedUrl = null;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    const body = JSON.parse(options.body);
    if (body.method === "initialize") return sseInitializeResponse(body.id, "sess-x");
    return sseToolsCallResponse(body.id, { text: "ok", pages: 1, truncated: false });
  };
  const client = createPdfToolClient({ fetchImpl });
  await client.extract({ data: "AAA=" });
  assert.equal(capturedUrl, PDF_TOOL_DEFAULT_URL);
});

test("extract with a custom url uses that URL for all requests", async () => {
  let capturedUrls = [];
  const fetchImpl = async (url, options) => {
    capturedUrls.push(url);
    const body = JSON.parse(options.body);
    if (body.method === "initialize") return sseInitializeResponse(body.id, "sess-1", "http://custom:9000/mcp");
    return sseToolsCallResponse(body.id, { text: "ok", pages: 1, truncated: false });
  };
  const client = createPdfToolClient({ url: "http://custom:9000/mcp", fetchImpl });
  await client.extract({ data: "AAA=" });
  assert.equal(capturedUrls.every((u) => u === "http://custom:9000/mcp"), true);
});

test("extract throws PdfToolError with the upstream code on a JSON-RPC error envelope", async () => {
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "initialize") return sseInitializeResponse(body.id, "sess-1");
    return sseResponse(200, {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: "Tool extract_pdf_from_base64 not found" },
    });
  };
  const client = createPdfToolClient({ fetchImpl });
  await assert.rejects(
    () => client.extract({ data: "AAA=" }),
    (error) =>
      error instanceof PdfToolError &&
      error.code === "-32601" &&
      /not found/.test(error.message),
  );
});

test("extract throws PdfToolError(pdf_tool_unavailable) on a network error", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const client = createPdfToolClient({ fetchImpl });
  await assert.rejects(
    () => client.extract({ data: "AAA=" }),
    (error) => error instanceof PdfToolError && error.code === "pdf_tool_unavailable",
  );
});

test("extract throws PdfToolError(pdf_tool_timeout) on an abort", async () => {
  const fetchImpl = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  const client = createPdfToolClient({ fetchImpl, timeoutMs: 50 });
  await assert.rejects(
    () => client.extract({ data: "AAA=" }),
    (error) => error instanceof PdfToolError && error.code === "pdf_tool_timeout",
  );
});

test("extract reuses the cached session id on the second call", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ method: body.method, sessionId: options.headers["mcp-session-id"] });
    if (body.method === "initialize") return sseInitializeResponse(body.id, "sess-reuse");
    return sseToolsCallResponse(body.id, { text: "first", pages: 1, truncated: false });
  };
  const client = createPdfToolClient({ fetchImpl });
  await client.extract({ data: "AAA=" });
  await client.extract({ data: "AAA=" });
  // First extract: initialize (no session) + tools/call (session)
  // Second extract: only tools/call (session, no new initialize)
  assert.equal(calls[0].method, "initialize");
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[1].method, "tools/call");
  assert.equal(calls[1].sessionId, "sess-reuse");
  assert.equal(calls[2].method, "tools/call");
  assert.equal(calls[2].sessionId, "sess-reuse");
});

test("extract reconnects and retries once when the session expires (404)", async () => {
  const calls = [];
  let firstCall404 = true;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ method: body.method, sessionId: options.headers["mcp-session-id"] });
    if (body.method === "initialize") return sseInitializeResponse(body.id, "sess-new");
    if (body.method === "tools/call") {
      if (firstCall404) {
        firstCall404 = false;
        return new Response(null, { status: 404 });
      }
      return sseToolsCallResponse(body.id, { text: "recovered", pages: 2, truncated: false });
    }
    return new Response(null, { status: 404 });
  };
  const client = createPdfToolClient({ fetchImpl });
  const result = await client.extract({ data: "AAA=" });
  assert.equal(result.text, "recovered");
  assert.equal(result.pages, 2);
  // Flow: initialize, tools/call (404), initialize (retry), tools/call (success)
  assert.equal(calls.length, 4);
  assert.equal(calls[0].method, "initialize");
  assert.equal(calls[1].method, "tools/call");
  assert.equal(calls[2].method, "initialize");
  assert.equal(calls[3].method, "tools/call");
  // After the 404, session should be cleared before re-initializing
  assert.equal(calls[1].sessionId, "sess-new");
  assert.equal(calls[2].sessionId, undefined);
  assert.equal(calls[3].sessionId, "sess-new");
});

test("extract rejects empty payloads without calling the upstream", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return sseInitializeResponse(0, "sess-x");
  };
  const client = createPdfToolClient({ fetchImpl });
  await assert.rejects(
    () => client.extract({ data: "" }),
    (error) => error instanceof PdfToolError && error.code === "pdf_tool_malformed_request",
  );
  assert.equal(called, false);
});

test("extract accepts a JSON content-type response (non-SSE fallback)", async () => {
  let calledInitialize = false;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "initialize") {
      calledInitialize = true;
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "pdf-tool-sidecar", version: "0.1.0" },
        },
      }, "sess-json");
    }
    return jsonResponse(200, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ text: "JSON response", pages: 1, truncated: false }) }],
      },
    });
  };
  const client = createPdfToolClient({ fetchImpl });
  const result = await client.extract({ data: "AAA=" });
  assert.equal(calledInitialize, true);
  assert.equal(result.text, "JSON response");
});
