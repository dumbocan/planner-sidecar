const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const MAX_GRAPH_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_GRAPH_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_CONTENT_TYPE = "application/pdf";

export class GraphError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GraphError";
    this.status = status;
  }
}

function encodePath(value) {
  return encodeURIComponent(String(value));
}

function pageRows(response) {
  return Array.isArray(response?.value) ? response.value : [];
}

async function readBoundedJson(response, maxBytes = MAX_GRAPH_RESPONSE_BYTES) {
  if (response.status === 204) return null;
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GraphError("Outlook read response is unavailable", response.status);
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
        throw new GraphError("Outlook read response is unavailable", response.status);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new GraphError("Outlook read response is unavailable", response.status);
  }
  return JSON.parse(text);
}

async function readBoundedBinary(response, maxBytes = MAX_GRAPH_ATTACHMENT_BYTES) {
  if (response.status === 204) return Buffer.alloc(0);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GraphError("Outlook attachment response is unavailable", response.status);
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
        throw new GraphError("Outlook attachment response is unavailable", response.status);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new GraphError("Outlook attachment response is unavailable", response.status);
  }
  return Buffer.from(arrayBuffer);
}

export function createGraphClient({
  getAccessToken,
  fetchImpl = globalThis.fetch,
  baseUrl = GRAPH_BASE_URL,
} = {}) {
  if (typeof getAccessToken !== "function" || typeof fetchImpl !== "function")
    throw new TypeError("Graph client dependencies are invalid");
  async function get(path, params = {}, headers = {}) {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`);
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(key, String(value));
    let token = await getAccessToken({ forceRefresh: false });
    let refreshed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, ...headers },
      });
      if (response.ok) return readBoundedJson(response);
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = await getAccessToken({ forceRefresh: true });
        continue;
      }
      throw new GraphError("Outlook read request failed", response.status);
    }
    throw new GraphError("Outlook read request failed", 401);
  }
  async function collect(path, params, headers, limit = 500) {
    const rows = [];
    let nextPath = path;
    let nextParams = params;
    while (nextPath && rows.length < limit) {
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
      const response = await fetchImpl(
        new URL(
          `${baseUrl.replace(/\/$/, "")}/me/messages/${encodePath(messageId)}/attachments/${encodePath(attachmentId)}/$value`,
        ),
        {
          method: "GET",
          headers: { authorization: `Bearer ${await getAccessToken({ forceRefresh: false })}` },
        },
      );
      if (!response.ok) throw new GraphError("Outlook attachment request failed", response.status);
      return readBoundedBinary(response, MAX_GRAPH_ATTACHMENT_BYTES);
    },
  };
}
