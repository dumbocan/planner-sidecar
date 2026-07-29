import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { ImapIntake } from './imap-client.js';
import { ImapState } from './state.js';
import { createMailTools, formatImapToolFailure, MAX_PDF_TEXT_CHARS, MAX_PDF_PAGES } from './tools.js';

const port = Number(process.env.PORT ?? 3000);
const state = new ImapState();
const intake = new ImapIntake({ state });
const tools = createMailTools({ state, intake, synchronize: () => intake.synchronize() });
const sessions = new Map();

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function failure(toolName, error) {
  const { log, response } = formatImapToolFailure(toolName, error);
  console.error(JSON.stringify(log));
  return response;
}

function createMcpServer() {
  const server = new McpServer({ name: 'laia-imap-sidecar', version: '0.1.0' });
  server.registerTool('mail_list_digest_candidates', {
    description: 'List bounded, sanitized metadata for recent IMAP intake candidates. Never sends or modifies mail.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional() }),
  }, async (input) => {
    try { return result(await tools.listDigestCandidates(input)); } catch (error) { return failure('mail_list_digest_candidates', error); }
  });
  server.registerTool('mail_get_sanitized_excerpt', {
    description: 'Read one bounded, redacted IMAP excerpt. Never returns raw MIME or attachments.',
    inputSchema: z.object({ messageId: z.string().min(1).max(512), maxChars: z.number().int().min(1).max(2000).optional() }),
  }, async (input) => {
    try { return result(await tools.getSanitizedExcerpt(input)); } catch (error) { return failure('mail_get_sanitized_excerpt', error); }
  });
  server.registerTool('mail_get_thread_metadata', {
    description: 'Read bounded metadata for messages in an existing IMAP thread. Never returns raw mail.',
    inputSchema: z.object({ messageId: z.string().min(1).max(512), limit: z.number().int().min(1).max(20).optional() }),
  }, async (input) => {
    try { return result(await tools.getThreadMetadata(input)); } catch (error) { return failure('mail_get_thread_metadata', error); }
  });
  server.registerTool('mail_list_mailboxes', {
    description: 'LIST selectable IMAP mailboxes for daily-use folder coverage. Excludes \\Noselect/\\NonExistent; never exposes counts, status, or message content.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  }, async (input) => {
    try { return result(await tools.listMailboxes(input)); } catch (error) { return failure('mail_list_mailboxes', error); }
  });
  server.registerTool('mail_search_in_mailbox', {
    description: 'Read-only IMAP search inside one selectable mailbox, bounded by an explicit date range and 20 results. Subject/sender filtering is envelope-only; never fetches body or source.',
    inputSchema: z.object({
      mailbox: z.string().min(1).max(256),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      senderFilter: z.string().min(1).max(256).optional(),
      subjectFilter: z.string().min(1).max(256).optional(),
      redact: z.boolean().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
  }, async (input) => {
    try { return result(await tools.searchMailbox(input)); } catch (error) { return failure('mail_search_in_mailbox', error); }
  });
  server.registerTool('mail_get_sanitized_in_folder', {
    description: 'Read one sanitized message excerpt from a specific folder by UID. Opens a read-only IMAP lock on the folder, fetches the text body (no attachments, no raw MIME), and returns it redacted. Requires folder (from mail_list_mailboxes) and uid (from mail_search_in_mailbox).',
    inputSchema: z.object({
      folder: z.string().min(1).max(256),
      uid: z.number().int().min(1),
    }),
  }, async (input) => {
    try { return result(await tools.getSanitizedInFolder(input)); } catch (error) { return failure('mail_get_sanitized_in_folder', error); }
  });
  server.registerTool('mail_list_attachments_in_folder', {
    description: 'List safe attachment metadata for one message by folder and UID: MIME part number, type, filename, size, disposition, and whether it is a PDF candidate. Walks the IMAP BODYSTRUCTURE; no attachment bytes leave the server. Requires folder (from mail_list_mailboxes) and uid (from mail_search_in_mailbox). Use this to discover PDF invoices before calling mail_extract_pdf_in_folder.',
    inputSchema: z.object({
      folder: z.string().min(1).max(256),
      uid: z.number().int().min(1),
    }),
  }, async (input) => {
    try { return result(await tools.listAttachmentsInFolder(input)); } catch (error) { return failure('mail_list_attachments_in_folder', error); }
  });
  server.registerTool('mail_extract_pdf_in_folder', {
    description: 'Extract text from a PDF attachment in a specific message by folder, UID, and MIME part number. Requires confirm:true. The PDF bytes are sent to the pdf-extractor-sidecar container; the extracted text is returned with a trustBoundary warning. The agent must surface the attachment filename to Javier and wait for explicit confirmation of one specific part before calling this tool.',
    inputSchema: z.object({
      folder: z.string().min(1).max(256),
      uid: z.number().int().min(1),
      part: z.string().regex(/^\d+(\.\d+)*$/),
      confirm: z.boolean(),
      maxChars: z.number().int().min(1).max(MAX_PDF_TEXT_CHARS).optional(),
      maxPages: z.number().int().min(1).max(MAX_PDF_PAGES).optional(),
    }),
  }, async (input) => {
    try { return result(await tools.extractPdfInFolder(input)); } catch (error) { return failure('mail_extract_pdf_in_folder', error); }
  });
  return server;
}

const server = createServer(async (request, response) => {
  if (request.url === '/healthz') return response.writeHead(200).end('ok');
  if (request.url !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(request.method ?? '')) return response.writeHead(404).end();
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const sessionId = request.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessions.has(sessionId)) return sessions.get(sessionId).handleRequest(request, response, body);
    if (!sessionId && body?.method === 'initialize') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => sessions.set(id, transport) });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      await createMcpServer().connect(transport);
      return transport.handleRequest(request, response, body);
    }
    response.writeHead(sessionId ? 404 : 400).end();
  } catch {
    response.writeHead(400).end();
  }
});

server.listen(port, '0.0.0.0');
