import assert from "node:assert/strict";
import test from "node:test";
import { createPdfExtractorClient, PdfExtractorError } from "../src/pdf-extractor-client.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("extract posts the base64 payload to the configured URL and returns the JSON body", async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return jsonResponse(200, { text: "Hello PDF", pages: 1, truncated: false });
  };
  const client = createPdfExtractorClient({
    url: "http://pdf-extractor-sidecar:3000/extract",
    fetchImpl,
    timeoutMs: 1000,
  });
  const result = await client.extract({ data: Buffer.from("%PDF-1.4").toString("base64"), maxPages: 5 });
  assert.equal(captured.url, "http://pdf-extractor-sidecar:3000/extract");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["content-type"], "application/json");
  const body = JSON.parse(captured.options.body);
  assert.equal(body.maxPages, 5);
  assert.ok(body.data.length > 0);
  assert.equal(result.text, "Hello PDF");
});

test("extract maps a 4xx response to a PdfExtractorError with the upstream code", async () => {
  const fetchImpl = async () => jsonResponse(413, { error: "pdf_too_large" });
  const client = createPdfExtractorClient({
    url: "http://pdf-extractor-sidecar:3000/extract",
    fetchImpl,
    timeoutMs: 1000,
  });
  await assert.rejects(
    () => client.extract({ data: "AAAA" }),
    (error) => error instanceof PdfExtractorError && /pdf_too_large/.test(error.message),
  );
});

test("extract rejects empty payloads without calling the upstream", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse(200, {});
  };
  const client = createPdfExtractorClient({
    url: "http://pdf-extractor-sidecar:3000/extract",
    fetchImpl,
  });
  await assert.rejects(
    () => client.extract({ data: "" }),
    /must include data/,
  );
  assert.equal(called, false);
});

test("extract times out and surfaces a generic error without leaking the URL or payload", async () => {
  const fetchImpl = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  const client = createPdfExtractorClient({
    url: "http://pdf-extractor-sidecar:3000/extract",
    fetchImpl,
    timeoutMs: 30,
  });
  await assert.rejects(
    () => client.extract({ data: "AAAA" }),
    (error) => error instanceof PdfExtractorError && /timed out|unreachable/.test(error.message),
  );
});

test("extract surfaces a connection failure as a generic error", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const client = createPdfExtractorClient({
    url: "http://pdf-extractor-sidecar:3000/extract",
    fetchImpl,
  });
  await assert.rejects(
    () => client.extract({ data: "AAAA" }),
    (error) => error instanceof PdfExtractorError && /unreachable/.test(error.message),
  );
});

test("health returns true on 2xx and false on failure without throwing", async () => {
  const fetchImpl = async () => jsonResponse(200, { ok: true });
  const client = createPdfExtractorClient({
    url: "http://pdf-extractor-sidecar:3000/extract",
    fetchImpl,
  });
  assert.equal(await client.health(), true);

  const failing = createPdfExtractorClient({
    url: "http://pdf-extractor-sidecar:3000/extract",
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(await failing.health(), false);
});