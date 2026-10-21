import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { calendarFailure, calendarSuccess, createRuntime, listen } from '../src/server.js';

test('createRuntime builds real auth and Graph clients without M365_CALENDAR_CLIENT_ID', async () => {
  const originalClientId = process.env.M365_CALENDAR_CLIENT_ID;
  const stateDir = await mkdtemp(path.join(tmpdir(), 'm365-calendar-server-'));
  try {
    delete process.env.M365_CALENDAR_CLIENT_ID;
    const runtime = createRuntime({ stateDir });
    assert.equal(typeof runtime.auth.acquireToken, 'function');
    assert.equal(typeof runtime.graph.getMe, 'function');
    assert.equal(typeof runtime.graph.listCalendars, 'function');
    assert.equal(typeof runtime.graph.updateEvent, 'function');
    assert.equal(typeof runtime.graph.deleteEvent, 'function');
    assert.deepEqual(await runtime.auth.getStatus(), { connected: false, expiresAt: null });
  } finally {
    if (originalClientId === undefined) delete process.env.M365_CALENDAR_CLIENT_ID;
    else process.env.M365_CALENDAR_CLIENT_ID = originalClientId;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('GET /healthz returns 200 ok on a random port', async () => {
  const handle = await listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  } finally {
    await handle.close();
  }
});

test('non-/healthz paths return 404 on the same listener', async () => {
  const handle = await listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/anything-else`);
    assert.equal(response.status, 404);
  } finally {
    await handle.close();
  }
});

test('non-GET methods on /healthz return 404', async () => {
  const handle = await listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`, { method: 'POST' });
    assert.equal(response.status, 404);
  } finally {
    await handle.close();
  }
});

test('non-POST/GET/DELETE methods on /mcp return 405', async () => {
  const handle = await listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: 'PUT' });
    assert.equal(response.status, 405);
  } finally {
    await handle.close();
  }
});

test('calendarFailure returns the generic envelope for non-GraphError and logs constructor name only', () => {
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = calendarFailure('calendar_list_calendars', new Error('secret message'));
    assert.equal(response.isError, true);
    assert.equal(response.content[0].text, 'M365 calendar sidecar is unavailable.');
    const parsed = JSON.parse(logs[0]);
    assert.deepEqual(parsed, {
      event: 'calendar_tool_failure',
      tool: 'calendar_list_calendars',
      error: 'Error',
    });
    assert.equal(logs.join('\n').includes('secret message'), false);
  } finally {
    console.error = original;
  }
});

test('calendarFailure returns specific message for GraphError 404', () => {
  class GraphError extends Error {
    constructor(message, { status }) { super(message); this.name = 'GraphError'; this.status = status; }
  }
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = calendarFailure('calendar_get_event', new GraphError('not found', { status: 404 }));
    assert.equal(response.isError, true);
    assert.equal(
      response.content[0].text,
      'The requested calendar item was not found. It may have been deleted or the identifier is incorrect.',
    );
  } finally {
    console.error = original;
  }
});

test('calendarFailure returns specific message for GraphError 401', () => {
  class GraphError extends Error {
    constructor(message, { status }) { super(message); this.name = 'GraphError'; this.status = status; }
  }
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = calendarFailure('calendar_list_calendars', new GraphError('unauthorized', { status: 401 }));
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /m365-calendar-sidecar onboard/);
  } finally {
    console.error = original;
  }
});

test('calendarFailure returns specific message for GraphError 500', () => {
  class GraphError extends Error {
    constructor(message, { status }) { super(message); this.name = 'GraphError'; this.status = status; }
  }
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = calendarFailure('calendar_list_calendars', new GraphError('server error', { status: 500 }));
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /status 500/);
  } finally {
    console.error = original;
  }
});

test('calendarSuccess logs a single structured audit line with no content leakage', () => {
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = calendarSuccess('calendar_list_calendars', 'default', [{ id: 'c1' }], 0);
    assert.equal(response.isError, undefined);
    assert.equal(JSON.parse(response.content[0].text)[0].id, 'c1');
    const parsed = JSON.parse(logs[0]);
    assert.deepEqual(parsed, {
      event: 'calendar_tool_call',
      tool: 'calendar_list_calendars',
      profile: 'default',
      result_count: 1,
      duration_ms: parsed.duration_ms,
    });
    assert.equal(logs.join('\n').includes('c1'), false);
  } finally {
    console.error = original;
  }
});

test('two concurrent MCP sessions stay usable at the same time', async () => {
  const handle = await listen(0);
  const endpoint = `http://127.0.0.1:${handle.port}/mcp`;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const bodyOf = (text, contentType) => {
    if (!String(contentType ?? '').includes('text/event-stream')) return JSON.parse(text);
    const line = text.split('\n').filter((entry) => entry.startsWith('data:')).at(-1);
    return line ? JSON.parse(line.slice(5).trim()) : null;
  };
  const openSession = async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
      }),
    });
    await response.text();
    assert.equal(response.status, 200);
    return response.headers.get('mcp-session-id');
  };
  const listTools = async (sessionId) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const parsed = bodyOf(await response.text(), response.headers.get('content-type'));
    return { status: response.status, tools: (parsed?.result?.tools ?? []).map((tool) => tool.name) };
  };
  try {
    // The gateway boots a read server and a write server against this endpoint,
    // so the second initialize must not invalidate the first session.
    const readSession = await openSession();
    const writeSession = await openSession();
    assert.notEqual(readSession, writeSession);
    const afterBoth = await listTools(readSession);
    assert.equal(afterBoth.status, 200);
    assert.ok(afterBoth.tools.includes('calendar_list_calendars'));
    const writes = await listTools(writeSession);
    assert.equal(writes.status, 200);
    assert.ok(writes.tools.includes('calendar_create_event'));
  } finally {
    await handle.close();
  }
});
