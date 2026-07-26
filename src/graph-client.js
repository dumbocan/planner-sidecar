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

    async function request(method, path, { body, select, top, query, headers: extraHeaders } = {}) {
    let accessToken = await getAccessToken({ forceRefresh: false });
    let refreshed = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const url = buildUrl(baseUrl, path, { select, top, query });
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...extraHeaders,
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
      const errorText = response.status === 400 ? ` (body: ${(await response.clone().text().catch(() => '')).substring(0, 200)})` : '';
      console.error(JSON.stringify({ event: 'graph_request_failed', method, url, status: response.status, text: errorText }));
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
    async getMe() {
      return await request('GET', '/me', { select: 'id' });
    },
    async listPlans() {
      const response = await request('GET', '/me/planner/plans', { select: 'id,title,owner' });
      return Array.isArray(response?.value) ? response.value : [];
    },
    async listBuckets(planId) {
      const response = await request('GET', `/planner/plans/${planId}/buckets`, {
        select: 'id,name,orderHint',
      });
      return Array.isArray(response?.value) ? response.value : [];
    },
    async listTasks(planId, { bucketId, dueBefore, dueAfter, assignedToMe } = {}) {
      const response = await request('GET', `/planner/plans/${planId}/tasks`, {
        select: 'id,title,bucketId,dueDateTime,percentComplete,assignments',
        top: 200,
      });
      const rows = Array.isArray(response?.value) ? response.value : [];
      const meId = assignedToMe ? (await this.getMe())?.id : null;
      return rows.filter((task) => {
        if (bucketId && task.bucketId !== bucketId) return false;
        if (dueBefore && typeof task.dueDateTime === 'string' && task.dueDateTime >= `${dueBefore}T23:59:59.999Z`) return false;
        if (dueAfter && typeof task.dueDateTime === 'string' && task.dueDateTime < `${dueAfter}T00:00:00.000Z`) return false;
        if (meId && assignedToMe) {
          const assignments = task.assignments && typeof task.assignments === 'object' ? task.assignments : {};
          if (!Object.hasOwn(assignments, meId)) return false;
        }
        return true;
      });
    },
    async getTask(taskId) {
      return await request('GET', `/planner/tasks/${taskId}`, {
        select: 'id,title,bucketId,dueDateTime,percentComplete,assignments',
      });
    },
    async getTaskWithEtag(taskId) {
      return await request('GET', `/planner/tasks/${taskId}`, {
        select: 'id,percentComplete',
      });
    },
    async updateTask(taskId, { percentComplete, dueDateTime, bucketId, title }) {
      const current = await this.getTaskWithEtag(taskId);
      const etag = current?.['@odata.etag'];
      if (!etag) throw new GraphError('Task not found or missing etag', { status: 404, url: `/planner/tasks/${taskId}`, method: 'PATCH' });

      const body = {};
      if (percentComplete !== undefined) body.percentComplete = percentComplete;
      if (dueDateTime !== undefined) body.dueDateTime = dueDateTime;
      if (bucketId !== undefined) body.bucketId = bucketId;
      if (title !== undefined) body.title = title;

      return await request('PATCH', `/planner/tasks/${taskId}`, {
        body,
        headers: { 'If-Match': etag },
      });
    },
    async deleteTask(taskId) {
      const current = await this.getTaskWithEtag(taskId);
      const etag = current?.['@odata.etag'];
      if (!etag) throw new GraphError('Task not found or missing etag', { status: 404, url: `/planner/tasks/${taskId}`, method: 'DELETE' });

      return await request('DELETE', `/planner/tasks/${taskId}`, {
        headers: { 'If-Match': etag },
      });
    },
    async createTask({ planId, bucketId, title, dueDateTime, selfAssignId }) {
      const me = selfAssignId ?? (await this.getMe())?.id;
      const body = {
        planId,
        bucketId,
        title,
        ...(dueDateTime ? { dueDateTime } : {}),
        assignments: me
          ? {
        [me]: {
          '@odata.type': 'microsoft.graph.plannerAssignment',
          orderHint: ' !',
        },
          }
          : {},
      };
      return await request('POST', '/planner/tasks', { body });
    },
    async createPlan(title, ownerGroupId) {
      return await request('POST', '/planner/plans', {
        body: { owner: ownerGroupId, title },
      });
    },
    async getBucketWithEtag(bucketId) {
      return await request('GET', `/planner/buckets/${bucketId}`, {
        select: 'id,name,planId',
      });
    },
    async updateBucket(bucketId, name) {
      const current = await this.getBucketWithEtag(bucketId);
      const etag = current?.['@odata.etag'];
      if (!etag) throw new GraphError('Bucket not found or missing etag', { status: 404, url: `/planner/buckets/${bucketId}`, method: 'PATCH' });
      return await request('PATCH', `/planner/buckets/${bucketId}`, {
        body: { name },
        headers: { 'If-Match': etag },
      });
    },
    async deleteBucket(bucketId) {
      const current = await this.getBucketWithEtag(bucketId);
      const etag = current?.['@odata.etag'];
      if (!etag) throw new GraphError('Bucket not found or missing etag', { status: 404, url: `/planner/buckets/${bucketId}`, method: 'DELETE' });
      return await request('DELETE', `/planner/buckets/${bucketId}`, {
        headers: { 'If-Match': etag },
      });
    },
    async createBucket(planId, name) {
      return await request('POST', '/planner/buckets', {
        body: { planId, name },
      });
    },
  };
}
