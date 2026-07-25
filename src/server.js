import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createAuthClient } from './auth.js';
import { createGraphClient } from './graph-client.js';
import { createProfileStore } from './profile-store.js';
import { TOOL_NAMES, createPlannerTools, plannerCreateTaskSchema, toolSchemas } from './tools.js';

const DEFAULT_PORT = 3000;
const DEFAULT_PROFILE = 'default';
const DEFAULT_SCOPES = ['Tasks.ReadWrite', 'Group.Read.All'];
const GENERIC_ERROR_TEXT = 'Planner sidecar is unavailable.';

const sessions = new Map();

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function resultCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return 1;
  return value === undefined || value === null ? 0 : 1;
}

export function plannerFailure(toolName, error) {
  const errorName = error?.constructor?.name ?? (typeof error === 'object' ? 'Error' : typeof error);
  console.error(JSON.stringify({ event: 'planner_tool_failure', tool: toolName, error: errorName }));
  return { content: [{ type: 'text', text: GENERIC_ERROR_TEXT }], isError: true };
}

export function plannerSuccess(toolName, profile, value, startedAt) {
  console.error(JSON.stringify({
    event: 'planner_tool_call',
    tool: toolName,
    profile,
    result_count: resultCount(value),
    duration_ms: Date.now() - startedAt,
  }));
  return toolResult(value);
}

function createRuntime({
  stateDir = process.env.PLANNER_STATE_DIR ?? './planner-state',
  profile = DEFAULT_PROFILE,
  clientId = process.env.PLANNER_CLIENT_ID,
  tenant = process.env.PLANNER_TENANT ?? 'common',
} = {}) {
  const profileStore = createProfileStore({ stateDir });
  const auth = clientId
    ? createAuthClient({ profile, stateDir, clientId, tenant })
    : {
      async acquireToken() {
        throw new Error('PLANNER_CLIENT_ID is required');
      },
      async getStatus() {
        return { connected: false, expiresAt: null };
      },
    };
  const graph = clientId
    ? createGraphClient({
      getAccessToken: async ({ forceRefresh } = {}) => {
        const token = await auth.acquireToken({ scopes: DEFAULT_SCOPES, forceRefresh });
        return token.accessToken;
      },
    })
    : {
      async getMe() {
        throw new Error('PLANNER_CLIENT_ID is required');
      },
      async listPlans() {
        throw new Error('PLANNER_CLIENT_ID is required');
      },
      async listBuckets() {
        throw new Error('PLANNER_CLIENT_ID is required');
      },
      async listTasks() {
        throw new Error('PLANNER_CLIENT_ID is required');
      },
      async getTask() {
        throw new Error('PLANNER_CLIENT_ID is required');
      },
      async createTask() {
        throw new Error('PLANNER_CLIENT_ID is required');
      },
    };
  const tools = createPlannerTools({ auth, graph, profileStore });
  return { auth, graph, profileStore, tools, profile };
}

function registerTool(server, toolName, description, schema, handler, profile = DEFAULT_PROFILE) {
  server.registerTool(toolName, { description, inputSchema: schema }, async (input) => {
    const startedAt = Date.now();
    try {
      const value = await handler(input);
      return plannerSuccess(toolName, profile, value, startedAt);
    } catch (error) {
      return plannerFailure(toolName, error);
    }
  });
}

export function createMcpServer(runtime = createRuntime()) {
  const server = new McpServer({ name: 'planner-sidecar', version: '0.1.0' });

  registerTool(
    server,
    'planner_list_profiles',
    'List loaded Planner profiles. Fase 1 always returns the single default profile.',
    toolSchemas.planner_list_profiles,
    (input) => runtime.tools.listProfiles(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_status',
    'Report Planner login status and cache expiry without exposing token content.',
    toolSchemas.planner_status,
    (input) => runtime.tools.status(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_list_plans',
    'List Planner plans owned by the authenticated user. Each plan has an opaque Microsoft Planner id string (must be passed verbatim to other planner tools).',
    toolSchemas.planner_list_plans,
    (input) => runtime.tools.listPlans(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_list_buckets',
    'List Planner buckets for one plan. plan_id is an opaque Microsoft Planner identifier string — pass it verbatim from planner_list_plans.',
    toolSchemas.planner_list_buckets,
    (input) => runtime.tools.listBuckets(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_list_tasks',
    'List Planner tasks with strict date and assignee filtering. plan_id and bucket_id are opaque Microsoft Planner identifier strings — pass them verbatim from planner_list_plans / planner_list_buckets.',
    toolSchemas.planner_list_tasks,
    (input) => runtime.tools.listTasks(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_get_task',
    'Get a single Planner task with truncated description by default. task_id is an opaque Microsoft Planner identifier string — pass it verbatim from planner_list_tasks.',
    toolSchemas.planner_get_task,
    (input) => runtime.tools.getTask(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_create_task',
    'Create a Planner task that self-assigns to the authenticated user. plan_id and bucket_id are opaque Microsoft Planner identifier strings — pass them verbatim from planner_list_plans / planner_list_buckets.',
    plannerCreateTaskSchema,
    (input) => runtime.tools.createTask(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_update_task',
    'Update a Planner task: mark complete (percentComplete), change due date, move to another bucket, or rename. task_id is an opaque Microsoft Planner identifier string — pass it verbatim from planner_list_tasks.',
    toolSchemas.planner_update_task,
    (input) => runtime.tools.updateTask(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_delete_task',
    'Delete a Planner task. Requires confirm: true. Ask the user before calling this. task_id is an opaque Microsoft Planner identifier string — pass it verbatim from planner_list_tasks.',
    toolSchemas.planner_delete_task,
    (input) => runtime.tools.deleteTask(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_create_plan',
    'Create a new Planner plan. title is required. If group_id is omitted, auto-detects the owner group from the first existing plan. The created plan is initially empty (no buckets or tasks).',
    toolSchemas.planner_create_plan,
    (input) => runtime.tools.createPlan(input),
    runtime.profile,
  );
  registerTool(
    server,
    'planner_create_bucket',
    'Create a new bucket in an existing Planner plan. plan_id is an opaque Microsoft Planner identifier string — pass it verbatim from planner_list_plans.',
    toolSchemas.planner_create_bucket,
    (input) => runtime.tools.createBucket(input),
    runtime.profile,
  );

  return server;
}

export function createApp(runtime = createRuntime()) {
  const toolRegistry = createMcpServer(runtime);
  let currentTransport = null;

  async function connectTransport(transport) {
    if (currentTransport) {
      try { await toolRegistry.close(); } catch {}
      currentTransport = null;
    }
    currentTransport = transport;
    await toolRegistry.connect(transport);
  }

  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200).end('ok');
      return;
    }

    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }

    if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
      response.writeHead(405).end();
      return;
    }

    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bodyText = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      const body = bodyText ? JSON.parse(bodyText) : undefined;
      const sessionId = request.headers['mcp-session-id'];

      if (typeof sessionId === 'string' && sessions.has(sessionId)) {
        return sessions.get(sessionId).handleRequest(request, response, body);
      }

      if (!sessionId && body?.method === 'initialize') {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => sessions.set(id, transport),
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await connectTransport(transport);
        return transport.handleRequest(request, response, body);
      }

      response.writeHead(sessionId ? 404 : 400).end();
    } catch (error) {
      console.error(JSON.stringify({ event: 'mcp_handler_error', message: error?.message, code: error?.code, name: error?.constructor?.name }));
      response.writeHead(400).end();
    }
  });
}

export function listen(port = Number(process.env.PORT ?? DEFAULT_PORT)) {
  return new Promise((resolve, reject) => {
    const server = createApp();
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => (error ? closeReject(error) : closeResolve()));
        }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listen().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
