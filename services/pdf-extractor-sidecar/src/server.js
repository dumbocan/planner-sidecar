import { createServer } from "node:http";
import { extractTextFromPdf, PdfExtractionError, MAX_PDF_BYTES } from "./extract.js";

const port = Number(process.env.PORT ?? 3000);
const MAX_REQUEST_BODY_BYTES = Math.ceil(MAX_PDF_BYTES * 1.4); // base64 overhead headroom
const MAX_BODY_BYTES_ENV = Number(process.env.PDF_EXTRACTOR_MAX_BODY_BYTES);
const effectiveMaxBody = Number.isFinite(MAX_BODY_BYTES_ENV) && MAX_BODY_BYTES_ENV > 0
  ? Math.min(MAX_BODY_BYTES_ENV, MAX_REQUEST_BODY_BYTES)
  : MAX_REQUEST_BODY_BYTES;
const PDF_EXTRACTION_TIMEOUT_MS = Number(process.env.PDF_EXTRACTION_TIMEOUT_MS) || 60_000; // 60s cap per request

class HttpBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "HttpBodyTooLargeError";
  }
}

class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadRequestError";
  }
}

class PdfExtractionTimeoutError extends Error {
  constructor() {
    super("PDF extraction timed out");
    this.name = "PdfExtractionTimeoutError";
  }
}

async function readBoundedJsonBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const length = chunk?.length ?? 0;
    total += length;
    if (total > maxBytes) {
      if (typeof request.destroy === "function") request.destroy();
      throw new HttpBodyTooLargeError();
    }
    chunks.push(chunk);
  }
  if (!chunks.length) throw new BadRequestError("empty body");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bad(message, status = 400) {
  return { status, body: { error: message } };
}

function logEvent(event, payload) {
  console.error(JSON.stringify({ event, ...payload }));
}

function failure(error) {
  if (error instanceof HttpBodyTooLargeError) {
    return bad("PDF extractor rejected the request body", 413);
  }
  if (error instanceof BadRequestError) {
    return bad("PDF extractor request was malformed", 400);
  }
  if (error instanceof PdfExtractionTimeoutError) {
    return bad("PDF extraction timed out", 408);
  }
  if (error instanceof PdfExtractionError) {
    return bad(`PDF extractor could not read the PDF (${error.code})`, 422);
  }
  return bad("PDF extractor failed", 500);
}

async function handleExtract(request) {
  let body;
  try {
    body = await readBoundedJsonBody(request, effectiveMaxBody);
  } catch (error) {
    return failure(error);
  }
  if (!body || typeof body !== "object") return bad("PDF extractor request was malformed", 400);
  if (typeof body.data !== "string") return bad("PDF extractor request must include data", 400);
  if (body.data.length === 0) return bad("PDF extractor request data is empty", 400);

  let buffer;
  try {
    buffer = Buffer.from(body.data, "base64");
  } catch {
    return bad("PDF extractor request data is not valid base64", 400);
  }
  // Reject early if base64 would have crossed our cap. Buffer.from does not
  // surface oversize inputs, so check the string length against the cap.
  if (body.data.length > Math.ceil(MAX_PDF_BYTES * 1.4)) {
    return bad("PDF extractor request data exceeds the size limit", 413);
  }

  // Hard timeout per extraction to prevent a malicious or malformed PDF from
  // hanging the server indefinitely. The AbortController is used rather than an
  // HTTP-level idle timeout because we want to cleanly abort pdfjs (which
  // supports loadingTask.abort()) and return a typed 408, not just drop the TCP
  // connection with an in-flight extraction.
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), PDF_EXTRACTION_TIMEOUT_MS);
  try {
    const result = await extractTextFromPdf(buffer, {
      maxPages: body.maxPages,
      maxChars: body.maxChars,
      signal: abortController.signal,
    });
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof PdfExtractionTimeoutError || abortController.signal.aborted) {
      logEvent("pdf_extractor_timeout", {});
      return failure(new PdfExtractionTimeoutError());
    }
    logEvent("pdf_extractor_failure", { error: error?.constructor?.name ?? "Error" });
    return failure(error);
  } finally {
    clearTimeout(abortTimer);
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/healthz" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (request.url !== "/extract" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const { status, body } = await handleExtract(request);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  } catch (error) {
    logEvent("pdf_extractor_unhandled", { error: error?.constructor?.name ?? "Error" });
    response.writeHead(500, { "content-type": "application/json" }).end(
      JSON.stringify({ error: "PDF extractor failed" }),
    );
  }
});

server.listen(port, "0.0.0.0");