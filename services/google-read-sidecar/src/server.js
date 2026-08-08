import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { createGoogleClients } from './google-client.js';
import { createPdfToolClient } from './pdf-tool-client.js';
import { createReadTools } from './tools.js';

const port = Number(process.env.PORT ?? 3000);
let clientsPromise;
let pdfToolClient;
const sessions = new Map();

async function getTools() {
  clientsPromise ??= createGoogleClients();
  if (!pdfToolClient) pdfToolClient = createPdfToolClient();
  const accounts = await clientsPromise;
  return createReadTools(accounts, { pdfToolClient });
}

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function failure(error) {
  return { content: [{ type: 'text', text: 'Google read-only integration is unavailable.' }], isError: true };
}

function createMcpServer() {
  const server = new McpServer({ name: 'laia-google-read-sidecar', version: '0.1.0' });
  const accountField = z.enum(['laia', 'personal']).optional().default('laia')
    .describe('Which Google account to use. "laia" (laijmelectronautica@gmail.com, contacts read+write) or "personal" (dumbo.cata@gmail.com, contacts read-only). Defaults to "laia".');
  const writeAccountField = z.enum(['laia']).optional().default('laia')
    .describe('Which Google account to use. Write operations are restricted to "laia" (laijmelectronautica@gmail.com). Defaults to "laia".');
  server.registerTool('gmail_search', {
    description: 'Search Gmail with an explicit result limit. Returns sanitized metadata only.',
    inputSchema: z.object({ query: z.string().min(1).max(500), maxResults: z.number().int().min(1).max(20).optional(), account: accountField }),
  }, async (input) => {
    try { return result(await (await getTools()).gmailSearch(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('gmail_get_sanitized', {
    description: 'Read one Gmail message as a bounded, redacted text excerpt. Never returns raw MIME.',
    inputSchema: z.object({ messageId: z.string().min(1).max(128), maxChars: z.number().int().min(1).max(2000).optional(), account: accountField }),
  }, async (input) => {
    try { return result(await (await getTools()).gmailGetSanitized(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('gmail_extract_pdf_attachment', {
    description:
      'Download a Gmail PDF attachment and extract text, invoice fields, and tabular line items ' +
      'via pdf-tool MCP. Requires confirm:true. Returns the same extraction shape as ' +
      'outlook_extract_pdf_attachment plus Gmail message/attachment metadata. Manual-only.',
    inputSchema: z.object({
      messageId: z.string().min(1).max(128),
      attachmentId: z.string().min(1).max(512),
      confirm: z.literal(true),
      maxChars: z.number().int().min(1).max(200000).optional(),
      maxPages: z.number().int().min(1).max(200).optional(),
      account: accountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).gmailExtractPdfAttachment(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('calendar_freebusy', {
    description: 'Read only Calendar free/busy windows. Does not create or modify calendar events.',
    inputSchema: z.object({
      timeMin: z.string().min(1),
      timeMax: z.string().min(1),
      calendarIds: z.array(z.string().min(1).max(320)).min(1).max(5).optional(),
      timeZone: z.string().min(1).max(128).optional(),
      account: accountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).calendarFreebusy(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('calendar_list_events', {
    description: 'List Calendar events with summary, start, end, attendees, and status. Read-only.',
    inputSchema: z.object({
      calendarId: z.string().min(1).max(320),
      timeMin: z.string().min(1),
      timeMax: z.string().min(1),
      maxResults: z.number().int().min(1).max(100).optional(),
      query: z.string().min(1).max(500).optional(),
      singleEvents: z.boolean().optional(),
      showDeleted: z.boolean().optional(),
      account: accountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).calendarListEvents(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('calendar_create_event', {
    description: 'Create a Calendar event. Write operations are restricted to the laia account; the runtime rejects other accounts even if the schema is bypassed.',
    inputSchema: z.object({
      calendarId: z.string().min(1).max(320),
      summary: z.string().min(1).max(1024),
      description: z.string().max(8192).optional(),
      start: z.object({ dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T/).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), timeZone: z.string().min(1).max(128).optional() }).passthrough(),
      end: z.object({ dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T/).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), timeZone: z.string().min(1).max(128).optional() }).passthrough(),
      timeZone: z.string().min(1).max(128).optional(),
      attendees: z.array(z.union([z.string().email(), z.object({ email: z.string().email() })])).max(100).optional(),
      account: writeAccountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).calendarCreateEvent(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('calendar_update_event', {
    description: 'Patch a Calendar event. Write operations are restricted to the laia account; the runtime rejects other accounts even if the schema is bypassed.',
    inputSchema: z.object({
      calendarId: z.string().min(1).max(320),
      eventId: z.string().min(1).max(1024),
      summary: z.string().min(1).max(1024).optional(),
      description: z.string().max(8192).optional(),
      start: z.object({ dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T/).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), timeZone: z.string().min(1).max(128).optional() }).passthrough().optional(),
      end: z.object({ dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T/).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), timeZone: z.string().min(1).max(128).optional() }).passthrough().optional(),
      timeZone: z.string().min(1).max(128).optional(),
      attendees: z.array(z.union([z.string().email(), z.object({ email: z.string().email() })])).max(100).optional(),
      account: writeAccountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).calendarUpdateEvent(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('calendar_delete_event', {
    description: 'Delete a Calendar event. Write operations are restricted to the laia account; the runtime rejects other accounts even if the schema is bypassed.',
    inputSchema: z.object({
      calendarId: z.string().min(1).max(320),
      eventId: z.string().min(1).max(1024),
      account: writeAccountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).calendarDeleteEvent(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('contacts_search', {
    description: 'Search Contacts by free-text query. Returns sanitized display name, given/family name, emails, phones, organization. Read-only.',
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      maxResults: z.number().int().min(1).max(100).optional(),
      readMask: z.string().min(1).max(1024).optional(),
      account: accountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).contactsSearch(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('contacts_get', {
    description: 'Fetch one Contact by resourceName. Read-only. resourceName must start with "people/".',
    inputSchema: z.object({
      resourceName: z.string().min(1).max(1024),
      personFields: z.string().min(1).max(1024).optional(),
      account: accountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).contactsGet(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('contacts_create', {
    description: 'Create a Contact. Write operations are restricted to the laia account; the runtime rejects other accounts even if the schema is bypassed. Requires at least one of: givenName, familyName, displayName, emailAddresses, phoneNumbers, organization.',
    inputSchema: z.object({
      givenName: z.string().min(1).max(128).optional(),
      familyName: z.string().min(1).max(128).optional(),
      displayName: z.string().min(1).max(256).optional(),
      emailAddresses: z.array(z.union([z.string(), z.object({ value: z.string().min(1).max(256) })])).max(20).optional(),
      phoneNumbers: z.array(z.union([z.string(), z.object({ value: z.string().min(1).max(32) })])).max(20).optional(),
      organization: z.string().min(1).max(256).optional(),
      account: writeAccountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).contactsCreate(input)); } catch (error) { return failure(error); }
  });
  server.registerTool('contacts_update', {
    description: 'Patch a Contact. Write operations are restricted to the laia account; the runtime rejects other accounts even if the schema is bypassed. Requires etag and at least one field to change.',
    inputSchema: z.object({
      resourceName: z.string().min(1).max(1024),
      etag: z.string().min(1).max(256),
      givenName: z.string().min(1).max(128).optional(),
      familyName: z.string().min(1).max(128).optional(),
      displayName: z.string().min(1).max(256).optional(),
      emailAddresses: z.array(z.union([z.string(), z.object({ value: z.string().min(1).max(256) })])).max(20).optional(),
      phoneNumbers: z.array(z.union([z.string(), z.object({ value: z.string().min(1).max(32) })])).max(20).optional(),
      organization: z.string().min(1).max(256).optional(),
      account: writeAccountField,
    }),
  }, async (input) => {
    try { return result(await (await getTools()).contactsUpdate(input)); } catch (error) { return failure(error); }
  });
  return server;
}

const server = createServer(async (request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200).end('ok');
    return;
  }
  if (request.url !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    const sessionId = request.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessions.has(sessionId)) {
      await sessions.get(sessionId).handleRequest(request, response, body);
      return;
    }
    if (!sessionId && body?.method === 'initialize') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await createMcpServer().connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }
    response.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: sessionId ? -32001 : -32000, message: sessionId ? 'Session not found' : 'Session ID required' },
      id: null,
    }));
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'invalid MCP request' }));
  }
});

server.listen(port, '0.0.0.0');
