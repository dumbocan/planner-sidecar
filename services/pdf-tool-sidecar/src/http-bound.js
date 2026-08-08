// 16 MiB raw request body cap. Matches the base64-expansion of MAX_PDF_BYTES (12 MiB raw PDF → ~16 MiB base64),
// so a max-size PDF just fits. Anything larger is rejected here before decodeBase64Pdf's size check fires.
export const MAX_MCP_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export class HttpBodyTooLargeError extends Error {
  constructor() {
    super("HTTP request body too large");
    this.name = "HttpBodyTooLargeError";
  }
}

export async function readBoundedJsonBody(request, maxBytes = MAX_MCP_REQUEST_BODY_BYTES) {
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
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
