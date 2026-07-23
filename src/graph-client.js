const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

export class GraphError extends Error {
  constructor(message, { status, url, method }) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.url = url;
    this.method = method;
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? GRAPH_BASE_URL).replace(/\/$/, '');
}

function toQueryString(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value)}`);
  }
  const query = parts.join('&');
  return query ? `?${query}` : '';
}

function buildUrl(baseUrl, path, { select, top = 200, query } = {}) {
  const normalizedPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`;
  const params = {
    ...(query ?? {}),
  };
  if (select) params['$select'] = Array.isArray(select) ? select.join(',') : select;
  if (top !== undefined && top !== null) params['$top'] = top;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}${toQueryString(params)}`;
}

function shouldRetry(status) {
  return status >= 500 && status < 600;
}

export function createGraphClient({
  getAccessToken,
  fetchImpl = globalThis.fetch,
  baseUrl = GRAPH_BASE_URL,
} = {}) {
  if (typeof getAccessToken !== 'function') {
    throw new TypeError('getAccessToken must be a function');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }

  async function request(method, path, { body, select, top, query } = {}) {
    let accessToken = await getAccessToken({ forceRefresh: false });
    let refreshed = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const url = buildUrl(baseUrl, path, { select, top, query });
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.ok) {
        if (response.status === 204) return null;
        return await response.json();
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        accessToken = await getAccessToken({ forceRefresh: true });
        continue;
      }

      if (shouldRetry(response.status) && attempt < 2) {
        continue;
      }
      throw new GraphError(`Graph request failed with ${response.status}`, {
        status: response.status,
        url,
        method,
      });
    }

  }

  return {
    getJson: (path, options) => request('GET', path, options),
    postJson: (path, body, options = {}) => request('POST', path, { ...options, body }),
    buildUrl: (path, options) => buildUrl(baseUrl, path, options),
  };
}
