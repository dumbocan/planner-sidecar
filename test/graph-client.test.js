import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphError, createGraphClient } from '../src/graph-client.js';

function makeResponse(status, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body ? JSON.parse(body) : {};
    },
    async text() {
      return body;
    },
  };
}

test('GET appends $select and default $top=200', async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => 'token-a',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(200, JSON.stringify({ value: [] }));
    },
  });

  await client.getJson('/me/planner/tasks', { select: ['id', 'title'] });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\$select=id,title/);
  assert.match(calls[0].url, /\$top=200/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer token-a');
});

test('401 refreshes token once and retries the request', async () => {
  const calls = [];
  const tokenCalls = [];
  const client = createGraphClient({
    getAccessToken: async (options = {}) => {
      tokenCalls.push(options);
      return options.forceRefresh ? 'token-b' : 'token-a';
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? makeResponse(401, 'denied') : makeResponse(200, JSON.stringify({ id: 'ok' }));
    },
  });

  const result = await client.getJson('/me');

  assert.deepEqual(result, { id: 'ok' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.authorization, 'Bearer token-a');
  assert.equal(calls[1].init.headers.authorization, 'Bearer token-b');
  assert.deepEqual(tokenCalls, [{ forceRefresh: false }, { forceRefresh: true }]);
});

test('5xx responses retry twice before succeeding', async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => 'token-a',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length < 3) return makeResponse(502, 'bad gateway');
      return makeResponse(200, JSON.stringify({ value: ['ok'] }));
    },
  });

  const result = await client.getJson('/me/planner/plans');

  assert.deepEqual(result, { value: ['ok'] });
  assert.equal(calls.length, 3);
});

test('4xx GraphError keeps body text out of the message', async () => {
  const client = createGraphClient({
    getAccessToken: async () => 'token-a',
    fetchImpl: async () => makeResponse(400, 'secret body must not leak'),
  });

  await assert.rejects(
    client.getJson('/me'),
    (error) => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.status, 400);
      assert.equal(error.message.includes('secret body must not leak'), false);
      return true;
    },
  );
});
