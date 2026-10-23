import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createAuthClient } from "./auth.js";
import { createGraphClient } from "./graph-client.js";
import { createProfileStore } from "./profile-store.js";
import { createCalendarTools, toolSchemas } from "./tools.js";

const DEFAULT_PORT = 3000;
const DEFAULT_PROFILE = "default";
// Baseline scopes ensure acquireTokenSilent works after device-code consent.
const DEFAULT_SCOPES = ["Calendars.ReadWrite", "openid", "profile", "email"];
const GENERIC_ERROR_TEXT = "M365 calendar sidecar is unavailable.";

const GRAPH_ERROR_MESSAGES = {
  400: "Bad request to Microsoft Graph. Verify field values and identifiers.",
  401: "Calendar authentication has expired or is invalid. Run `m365-calendar-sidecar onboard`.",
  403: "Access denied by Microsoft Graph. The account may lack the required permissions.",
  404: "The requested calendar item was not found. It may have been deleted or the identifier is incorrect.",
  409: "Conflict detected. The item may have been modified by another session.",
  429: "Rate limited by Microsoft Graph. Try again later.",
};

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function resultCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return 1;
  return value === undefined || value === null ? 0 : 1;
}

export function calendarFailure(toolName, error) {
  const errorName =
    error?.constructor?.name ??
    (typeof error === "object" ? "Error" : typeof error);
  console.error(
    JSON.stringify({
      event: "calendar_tool_failure",
      tool: toolName,
      error: errorName,
    }),
  );
  const message =
    error?.constructor?.name === "GraphError"
      ? (GRAPH_ERROR_MESSAGES[error.status] ??
        `Microsoft Graph API returned status ${error.status}.`)
      : GENERIC_ERROR_TEXT;
  return { content: [{ type: "text", text: message }], isError: true };
}

export function calendarSuccess(toolName, profile, value, startedAt) {
  console.error(
    JSON.stringify({
      event: "calendar_tool_call",
      tool: toolName,
      profile,
      result_count: resultCount(value),
      duration_ms: Date.now() - startedAt,
    }),
  );
  return toolResult(value);
}

export function createRuntime({
  stateDir = process.env.M365_CALENDAR_STATE_DIR ?? "./calendar-state",
  profile = DEFAULT_PROFILE,
  clientId = process.env.M365_CALENDAR_CLIENT_ID,
  tenant = process.env.M365_CALENDAR_TENANT ?? "common",
} = {}) {
  const profileStore = createProfileStore({ stateDir });
  const auth = createAuthClient({ profile, stateDir, clientId, tenant });
  const graph = createGraphClient({
    getAccessToken: async ({ forceRefresh } = {}) => {
      const token = await auth.acquireToken({
        scopes: DEFAULT_SCOPES,
        forceRefresh,
      });
      return token.accessToken;
    },
  });
  const tools = createCalendarTools({ auth, graph, profileStore });
  return { auth, graph, profileStore, tools, profile };
}

function registerTool(
  server,
  toolName,
  description,
  schema,
  handler,
  profile = DEFAULT_PROFILE,
) {
  server.registerTool(
    toolName,
    { description, inputSchema: schema },
    async (input) => {
      const startedAt = Date.now();
      try {
        const value = await handler(input);
        return calendarSuccess(toolName, profile, value, startedAt);
      } catch (error) {
        return calendarFailure(toolName, error);
      }
    },
  );
}

export function createMcpServer(runtime = createRuntime()) {
  const server = new McpServer({
    name: "m365-calendar-sidecar",
    version: "0.1.0",
  });

  registerTool(
    server,
    "calendar_list_profiles",
    "List loaded Microsoft 365 Calendar profiles. The default surface returns the single default profile.",
    toolSchemas.calendar_list_profiles,
    (input) => runtime.tools.listProfiles(input),
    runtime.profile,
  );
  registerTool(
    server,
    "calendar_status",
    "Report Microsoft 365 Calendar login status and cache expiry without exposing token content.",
    toolSchemas.calendar_status,
    (input) => runtime.tools.status(input),
    runtime.profile,
  );
  registerTool(
    server,
    "calendar_list_calendars",
    "List Microsoft 365 Calendars available to the authenticated user. Each calendar has an opaque Microsoft identifier string (must be passed verbatim to other calendar tools).",
    toolSchemas.calendar_list_calendars,
    (input) => runtime.tools.listCalendars(input),
    runtime.profile,
  );
  registerTool(
    server,
    "calendar_list_events",
    "List Microsoft 365 Calendar events with strict date range filtering (max 365 days). start_date and end_date are YYYY-MM-DD strings. calendar_id is optional and is an opaque Microsoft calendar identifier string — pass it verbatim from calendar_list_calendars.",
    toolSchemas.calendar_list_events,
    (input) => runtime.tools.listEvents(input),
    runtime.profile,
  );
  registerTool(
    server,
    "calendar_get_event",
    "Get a single Microsoft 365 Calendar event by event_id. event_id is an opaque Microsoft event identifier string — pass it verbatim from calendar_list_events. For non-default calendars, include calendar_id (also verbatim from calendar_list_calendars) so Microsoft Graph routes to /me/calendars/{calendarId}/events/{eventId}.",
    toolSchemas.calendar_get_event,
    (input) => runtime.tools.getEvent(input),
    runtime.profile,
  );
  registerTool(
    server,
    "calendar_create_event",
    "Create a Microsoft 365 Calendar event. start_date and end_date are YYYY-MM-DD; start_time and end_time are HH:MM (24-hour). The combined time returns an ISO 8601 dateTime. times use the time_zone field when supplied (default UTC). calendar_id is optional and is an opaque Microsoft calendar identifier string — pass it verbatim from calendar_list_calendars.",
    toolSchemas.calendar_create_event,
    (input) => runtime.tools.createEvent(input),
    runtime.profile,
  );
  registerTool(
    server,
    "calendar_update_event",
    "Update a Microsoft 365 Calendar event. REQUIRES confirm: true literal. event_id is an opaque Microsoft event identifier string — pass it verbatim from calendar_list_events. For non-default calendars, include calendar_id (verbatim from calendar_list_calendars). Only the fields you supply are updated. start_date and start_time must be sent together; end_date and end_time must be sent together. At least one field must change.",
    toolSchemas.calendar_update_event,
    (input) => runtime.tools.updateEvent(input),
    runtime.profile,
  );
  registerTool(
    server,
    "calendar_delete_event",
    "Delete a Microsoft 365 Calendar event. CRITICAL: REQUIRES confirm: true literal AND you MUST ask the user for explicit yes/no confirmation before calling this. The user must know WHICH event is being deleted. event_id is an opaque Microsoft event identifier string — pass it verbatim from calendar_list_events. For non-default calendars, include calendar_id (verbatim from calendar_list_calendars).",
    toolSchemas.calendar_delete_event,
    (input) => runtime.tools.deleteEvent(input),
    runtime.profile,
  );

  return server;
}

export function createApp(runtime = createRuntime()) {
  // Sessions are keyed per app instance: the gateway opens a read server and a
  // write server against this same endpoint, so they must not share state.
  const sessions = new Map();

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200).end("ok");
      return;
    }

    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }

    if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) {
      response.writeHead(405).end();
      return;
    }

    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bodyText = chunks.length
        ? Buffer.concat(chunks).toString("utf8")
        : "";
      const body = bodyText ? JSON.parse(bodyText) : undefined;
      const sessionId = request.headers["mcp-session-id"];

      if (typeof sessionId === "string" && sessions.has(sessionId)) {
        return sessions.get(sessionId).handleRequest(request, response, body);
      }

      if (!sessionId && body?.method === "initialize") {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => sessions.set(id, transport),
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        // One McpServer per session. A single shared registry had to close the
        // previous connection on every new initialize, which dropped the peer
        // session as soon as a second MCP server booted against this endpoint.
        const sessionServer = createMcpServer(runtime);
        await sessionServer.connect(transport);
        return transport.handleRequest(request, response, body);
      }

      response.writeHead(sessionId ? 404 : 400).end();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "mcp_handler_error",
          message: error?.message,
          code: error?.code,
          name: error?.constructor?.name,
        }),
      );
      response.writeHead(400).end();
    }
  });
}

export function listen(port = Number(process.env.PORT ?? DEFAULT_PORT)) {
  return new Promise((resolve, reject) => {
    const server = createApp();
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      const boundPort =
        typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) =>
              error ? closeReject(error) : closeResolve(),
            );
          }),
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "0.0.0.0");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listen().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
