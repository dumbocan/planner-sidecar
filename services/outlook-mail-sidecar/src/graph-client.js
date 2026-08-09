const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const MAX_GRAPH_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_GRAPH_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_CONTENT_TYPE = "application/pdf";

export const MAX_GRAPH_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 8_000;

export class GraphError extends Error {
  constructor(message, { status, url, method } = {}) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.url = url;
    this.method = method;
  }
}

function encodePath(value) {
  return encodeURIComponent(String(value));
}

function pageRows(response) {
  return Array.isArray(response?.value) ? response.value : [];
}

function shouldRetryStatus(status) {
  // 429: throttled; Microsoft Graph sends Retry-After. 5xx: transient.
  // 4xx other than 401 is permanent; 401 is handled by the caller with
  // forceRefresh and a single retry.
  return status === 429 || (status >= 500 && status < 600);
}

function parseRetryAfter(response) {
  const value = response?.headers?.get?.("retry-after");
  if (typeof value !== "string" || !value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function backoffMs(attempt, retryAfter) {
  if (retryAfter != null) return Math.min(RETRY_CAP_MS, Math.max(retryAfter, 0));
  // Exponential backoff with ±20% jitter: 250, 1000, 4000 ms.
  const base = RETRY_BASE_MS * 2 ** attempt;
  const jitter = base * (0.2 * Math.random() - 0.1);
  return Math.min(RETRY_CAP_MS, base + jitter);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBoundedJson(response, maxBytes = MAX_GRAPH_RESPONSE_BYTES) {
  if (response.status === 204) return null;
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GraphError("Outlook read response is unavailable", { status: response.status });
  }
  const reader =
    response.body && typeof response.body.getReader === "function"
      ? response.body.getReader()
      : null;
  if (reader) {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GraphError("Outlook read response is unavailable", { status: response.status });
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new GraphError("Outlook read response is unavailable", { status: response.status });
  }
  return JSON.parse(text);
}

async function readBoundedBinary(response, maxBytes = MAX_GRAPH_ATTACHMENT_BYTES) {
  if (response.status === 204) return Buffer.alloc(0);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GraphError("Outlook attachment response is unavailable", { status: response.status });
  }
  const reader =
    response.body && typeof response.body.getReader === "function"
      ? response.body.getReader()
      : null;
  if (reader) {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GraphError("Outlook attachment response is unavailable", {
          status: response.status,
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new GraphError("Outlook attachment response is unavailable", { status: response.status });
  }
  return Buffer.from(arrayBuffer);
}

export function createGraphClient({
  getAccessToken,
  fetchImpl = globalThis.fetch,
  baseUrl = GRAPH_BASE_URL,
  sleepImpl = sleep,
} = {}) {
  if (typeof getAccessToken !== "function" || typeof fetchImpl !== "function")
    throw new TypeError("Graph client dependencies are invalid");

  function buildUrl(path, params = {}) {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`);
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  }

  // Shared retry loop. Returns the successful Response; throws GraphError on
  // permanent failure. 401 is handled by the caller with forceRefresh, not here.
  async function runRequest(method, path, { params, headers, accessToken, fetchImpl: clientFetch } = {}) {
    const fetchFn = clientFetch ?? fetchImpl;
    const url = buildUrl(path, params);
    let lastResponse = null;
    for (let attempt = 0; attempt < MAX_GRAPH_ATTEMPTS; attempt += 1) {
      const response = await fetchFn(url, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, ...headers },
      });
      if (response.ok) return response;
      lastResponse = response;
      if (shouldRetryStatus(response.status) && attempt < MAX_GRAPH_ATTEMPTS - 1) {
        const wait = backoffMs(attempt, parseRetryAfter(response));
        await sleepImpl(wait);
        continue;
      }
      throw new GraphError("Outlook request failed", {
        status: response.status,
        url: url.toString(),
        method,
      });
    }
    // Unreachable: the loop always returns or throws on the last attempt.
    throw new GraphError("Outlook request failed", {
      status: lastResponse?.status,
      url: url.toString(),
      method,
    });
  }

  async function get(path, params = {}, headers = {}, { accessToken } = {}) {
    const token = accessToken ?? (await getAccessToken({ forceRefresh: false }));
    let refreshed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await runRequest("GET", path, {
          params,
          headers,
          accessToken: token,
        });
        return await readBoundedJson(response);
      } catch (error) {
        if (error?.status === 401 && !refreshed) {
          refreshed = true;
          // Single forced refresh; if this still returns 401 the next runRequest
          // call will throw a GraphError with the real status.
          // eslint-disable-next-line no-await-in-loop
          token = await getAccessToken({ forceRefresh: true });
          continue;
        }
        throw error;
      }
    }
    throw new GraphError("Outlook read request failed", { status: 401, url: path, method: "GET" });
  }

  async function collect(path, params, headers, limit = 500) {
    const rows = [];
    let nextPath = path;
    let nextParams = params;
    while (nextPath && rows.length < limit) {
      // eslint-disable-next-line no-await-in-loop
      const response = await get(nextPath, nextParams, headers);
      rows.push(...pageRows(response));
      const next =
        typeof response?.["@odata.nextLink"] === "string"
          ? new URL(response["@odata.nextLink"])
          : null;
      nextPath = next ? `${next.pathname}` : null;
      nextParams = next ? Object.fromEntries(next.searchParams.entries()) : undefined;
    }
    return rows.slice(0, limit);
  }

  return {
    async listFolders() {
      const options = {
        $top: 100,
        $select: "id,displayName,parentFolderId,childFolderCount,isHidden",
        includeHiddenFolders: false,
      };
      const folders = await collect("/me/mailFolders", options, undefined, 500);
      const queue = folders.filter((folder) => Number(folder.childFolderCount) > 0);
      while (queue.length > 0 && folders.length < 500) {
        const parent = queue.shift();
        // eslint-disable-next-line no-await-in-loop
        const children = await collect(
          `/me/mailFolders/${encodePath(parent.id)}/childFolders`,
          options,
          undefined,
          500 - folders.length,
        );
        folders.push(...children);
        queue.push(...children.filter((folder) => Number(folder.childFolderCount) > 0));
      }
      return folders;
    },
    async listMessages({ folderId, top = 50, query } = {}) {
      const path = folderId ? `/me/mailFolders/${encodePath(folderId)}/messages` : "/me/messages";
      const params = {
        $top: Math.min(Math.max(Number(top) || 50, 1), 50),
        $select: "subject,sender,from,receivedDateTime,bodyPreview,isRead,importance",
      };
      if (query) params.$search = `"${String(query).replaceAll('"', "")}"`;
      else params.$orderby = "receivedDateTime desc";
      return collect(
        path,
        params,
        query ? { ConsistencyLevel: "eventual" } : undefined,
        params.$top,
      );
    },
    async getMessage(messageId) {
      return get(
        `/me/messages/${encodePath(messageId)}`,
        { $select: "subject,sender,from,receivedDateTime,body,bodyPreview,isRead,importance" },
        { Prefer: 'outlook.body-content-type="html"' },
      );
    },
    async listMessageAttachments(messageId) {
      return get(`/me/messages/${encodePath(messageId)}/attachments`, {
        $select: "id,name,contentType,size,isInline",
        $top: 50,
      }).then((response) => (Array.isArray(response?.value) ? response.value : []));
    },
    async getAttachmentMetadata(messageId, attachmentId) {
      return get(
        `/me/messages/${encodePath(messageId)}/attachments/${encodePath(attachmentId)}`,
        { $select: "id,name,contentType,size,isInline" },
      );
    },
    async getAttachmentRawContent(messageId, attachmentId) {
      // $value returns the raw bytes for a fileAttachment. We fetch with the
      // bounded reader so an oversized attachment is rejected before parsing.
      // 401 is handled with a single forced refresh so a token nearing expiry
      // does not fail the whole stream.
      const path = `/me/messages/${encodePath(messageId)}/attachments/${encodePath(
        attachmentId,
      )}/$value`;
      let token = await getAccessToken({ forceRefresh: false });
      let refreshed = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await runRequest("GET", path, {
            params: undefined,
            headers: undefined,
            accessToken: token,
          });
          return await readBoundedBinary(response, MAX_GRAPH_ATTACHMENT_BYTES);
        } catch (error) {
          if (error?.status === 401 && !refreshed) {
            refreshed = true;
            // eslint-disable-next-line no-await-in-loop
            token = await getAccessToken({ forceRefresh: true });
            continue;
          }
          throw error;
        }
      }
      throw new GraphError("Outlook attachment request failed", {
        status: 401,
        url: path,
        method: "GET",
      });
    },
  };
}
