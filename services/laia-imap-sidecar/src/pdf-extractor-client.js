// Internal HTTP client for the PDF extractor sidecar. The IMAP sidecar never sees raw
// attachment bytes outside the in-memory Buffer flow; this client is the only path that
// crosses the container boundary into the extractor.

import { request } from 'node:http';

export const PDF_EXTRACTOR_TIMEOUT_MS = 30_000;

export class PdfExtractorError extends Error {
  constructor(message, code = 'pdf_extractor_unavailable') {
    super(message);
    this.name = 'PdfExtractorError';
    this.code = code;
  }
}

export function createPdfExtractorClient({
  url = process.env.PDF_EXTRACTOR_URL ?? 'http://pdf-extractor-sidecar:3000/extract',
  fetchImpl = globalThis.fetch,
  timeoutMs = PDF_EXTRACTOR_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  async function post(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new PdfExtractorError('PDF extractor returned a non-JSON response');
      }
      if (!response.ok) {
        const code = typeof parsed?.error === 'string' ? parsed.error : 'pdf_extractor_unavailable';
        throw new PdfExtractorError(`PDF extractor rejected the request (${code})`, code);
      }
      return parsed;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new PdfExtractorError('PDF extractor timed out', 'pdf_extractor_timeout');
      }
      if (error instanceof PdfExtractorError) throw error;
      throw new PdfExtractorError('PDF extractor is unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    url,
    async extract({ data, maxPages, maxChars }) {
      if (typeof data !== 'string' || data.length === 0) {
        throw new PdfExtractorError('PDF extractor request must include data', 'pdf_invalid_request');
      }
      return post({ data, maxPages, maxChars });
    },
    async health() {
      try {
        const response = await fetchImpl(
          url.replace(/\/extract$/, '/healthz'),
          { method: 'GET', signal: AbortSignal.timeout(timeoutMs) },
        );
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

// Re-export the http.request handle for tests that want to assert the URL and
// method. Production code uses fetchImpl.
export function _internalRequestHandle() {
  return request;
}
