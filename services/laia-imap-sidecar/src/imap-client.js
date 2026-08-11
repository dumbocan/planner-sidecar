import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ImapFlow } from 'imapflow';

import {
  MAX_MAILBOX_LIST,
  MAX_SEARCH_RESULTS,
  createReadOnlyImapClientOptions,
  listSelectableMailboxes,
  sanitizeExcerpt,
  selectSelectablePaths,
  validateDateRange,
  validateFilter,
  validateMailboxPath,
} from './tools.js';

function boundedString(value, maximum) {
  return String(value ?? '').slice(0, maximum);
}

const SECRET_DIR = '/run/secrets/imap-read-only';
const MAX_LITERAL_BYTES = 64 * 1024;
const LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_BOOTSTRAP_DAYS = 30;
const MAX_BOOTSTRAP_DAYS = 365;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ENVELOPE_BATCH_MULTIPLIER = 4;
const MAX_CONNECT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4_000;
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);
const TRANSIENT_IMAP_PATTERN = /too.?many|rate.?limit|throttl|try.?again|temporar|overload|service.?unavailab/i;
const MAX_ATTACHMENT_LIST = 20;

// imapflow returns raw part bytes with the original Content-Transfer-Encoding.
// Decode base64/quoted-printable so the %PDF- magic check sees real bytes.
function decodeQuotedPrintable(buffer) {
  const text = buffer.toString('latin1');
  const unescaped = text.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(unescaped.replace(/=\r?\n/g, ''), 'latin1');
}
function decodePartEncoding(buffer, encoding) {
  const enc = typeof encoding === 'string' ? encoding.toLowerCase() : null;
  if (enc === 'base64') return Buffer.from(buffer.toString('latin1'), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(buffer);
  return buffer;
}

export function isTransientImapError(error) {
  if (!error) return false;
  if (NETWORK_ERROR_CODES.has(error.code)) return true;
  if (typeof error.responseStatus === 'string' && TRANSIENT_IMAP_PATTERN.test(error.responseStatus)) return true;
  if (typeof error.responseText === 'string' && TRANSIENT_IMAP_PATTERN.test(error.responseText)) return true;
  if (typeof error.message === 'string' && TRANSIENT_IMAP_PATTERN.test(error.message)) return true;
  return false;
}

const SENT_MAILBOX_NAMES = new Set([
  'sent',
  'sent items',
  'sent mail',
  'enviados',
  'enviado',
  'gesendet',
  'inviati',
  'posta inviata',
  'outbox',
]);

export function readBootstrapDays(value = process.env.IMAP_BOOTSTRAP_DAYS) {
  if (value === undefined) return DEFAULT_BOOTSTRAP_DAYS;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`IMAP_BOOTSTRAP_DAYS must be an integer between 1 and ${MAX_BOOTSTRAP_DAYS}`);
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days > MAX_BOOTSTRAP_DAYS) {
    throw new Error(`IMAP_BOOTSTRAP_DAYS must be an integer between 1 and ${MAX_BOOTSTRAP_DAYS}`);
  }
  return days;
}

function bootstrapSearchDate(cutoff) {
  // IMAP SINCE is date-granular; include the preceding UTC calendar day, then filter the exact internal date below.
  return new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate() - 1));
}

function isoDayString(date) {
  return date.toISOString().slice(0, 10);
}

export function selectSyncMailboxes(mailboxes) {
  if (!Array.isArray(mailboxes)) throw new Error('IMAP mailbox list is invalid');
  return mailboxes.filter((mailbox) => {
    if (mailbox?.path === 'INBOX' || mailbox?.specialUse === '\\Sent') return true;
    return SENT_MAILBOX_NAMES.has(String(mailbox?.name ?? '').trim().toLowerCase());
  });
}

export async function readFileCredentials(secretDir = SECRET_DIR) {
  if (path.resolve(secretDir) !== SECRET_DIR) throw new Error('IMAP credentials must use the sidecar-only secret mount');
  const [user, pass] = await Promise.all([
    readFile(path.join(SECRET_DIR, 'username'), 'utf8'),
    readFile(path.join(SECRET_DIR, 'password'), 'utf8'),
  ]);
  if (!user.trim() || !pass.trim()) throw new Error('IMAP credential files are incomplete');
  return { user: user.trim(), pass: pass.trim() };
}

function normalizedMessageId(value) {
  const raw = String(value ?? '').trim();
  const bare = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).trim() : raw;
  if (!/^[^<>()\s@,;:\\"]+@[^<>()\s@,;:\\"]+$/.test(bare)) return null;
  return `<${bare.toLowerCase()}>`;
}

function parseBoundedLiteral(source) {
  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source ?? '');
  const bounded = raw.slice(0, MAX_LITERAL_BYTES);
  const headers = {};
  const unfolded = [];
  for (const line of bounded.split(/\r?\n\r?\n/, 1)[0].split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    else unfolded.push(line);
  }
  for (const line of unfolded) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const name = match[1].toLowerCase();
    headers[name] = Object.hasOwn(headers, name) ? null : match[2];
  }
  return { headers, body: bounded.replace(/^[\s\S]*?\r?\n\r?\n/, '') };
}

export class ImapIntake {
  constructor({
    state,
    ImapFlowImpl = ImapFlow,
    bootstrapDays = readBootstrapDays(),
    clock = () => new Date(),
    loadCredentials = readFileCredentials,
  }) {
    this.state = state;
    this.ImapFlowImpl = ImapFlowImpl;
    this.bootstrapDays = readBootstrapDays(String(bootstrapDays));
    this.clock = clock;
    this.loadCredentials = loadCredentials;
    this.running = false;
  }

  async withReadOnlyClient(worker) {
    // Retry transient IMAP/network failures with exponential backoff. Hostinger limits
    // concurrent connections per account, so a burst of live queries (mail_list_mailboxes,
    // mail_search_in_mailbox) can hit a temporary rejection. Permanent failures
    // (validation, "mailbox path is not selectable") are NOT retried.
    let lastError;
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt += 1) {
      let client;
      try {
        client = new this.ImapFlowImpl(createReadOnlyImapClientOptions(await this.loadCredentials()));
        await client.connect();
        return await worker(client);
      } catch (error) {
        lastError = error;
        const canRetry = isTransientImapError(error) && attempt < MAX_CONNECT_ATTEMPTS - 1;
        if (!canRetry) throw error;
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        if (client) await client.logout().catch(() => client.close());
      }
    }
    throw lastError;
  }

  async synchronize() {
    if (this.running) throw new Error('IMAP synchronization already in progress');
    this.running = true;
    try {
      await this.withReadOnlyClient(async (client) => {
        const selected = selectSyncMailboxes(await client.list());
        for (const mailbox of selected) await this.synchronizeMailbox(client, mailbox.path);
      });
    } finally {
      this.running = false;
    }
  }

  async listMailboxes({ limit } = {}) {
    const boundedLimit = Math.min(Math.max(Number(limit) || MAX_MAILBOX_LIST, 1), MAX_MAILBOX_LIST);
    return this.withReadOnlyClient((client) => this.collectMailboxesFromClient(client, boundedLimit));
  }

  async collectMailboxesFromClient(client, limit) {
    const mailboxes = await client.list();
    return listSelectableMailboxes(mailboxes, limit);
  }

  async searchMailbox(input = {}) {
    const mailbox = validateMailboxPath(input.mailbox);
    const { from, to } = validateDateRange(input.fromDate, input.toDate);
    const senderFilter = validateFilter(input.senderFilter, 'senderFilter');
    const subjectFilter = validateFilter(input.subjectFilter, 'subjectFilter');
    const redact = input.redact === false ? false : true;
    const limit = Math.min(Math.max(Number(input.limit) || MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
    return this.withReadOnlyClient((client) => this.collectMailboxCandidates(client, {
      mailbox,
      from,
      to,
      senderFilter,
      subjectFilter,
      redact,
      limit,
    }));
  }

  // Helper: extract the filename from a MIME body structure node. Returns null if none.
  structureFilename(node) {
    if (!node) return null;
    // RFC 2183: Content-Disposition filename parameter takes priority
    const dispositionName = node.dispositionParameters?.filename ?? node.dispositionParameters?.['filename*'] ?? null;
    if (typeof dispositionName === 'string' && dispositionName.trim()) return dispositionName.trim();
    // Fallback: Content-Type name parameter (common in application/* inline attachments)
    const typeName = node.parameters?.name ?? node.parameters?.['name*'] ?? null;
    if (typeof typeName === 'string' && typeName.trim()) return typeName.trim();
    return null;
  }

  // Helper: walk the BODYSTRUCTURE tree and collect attachment metadata. Returns array of
  // { part, type, size, filename, disposition, isPdf } for every leaf part.
  walkStructure(node, path = []) {
    const results = [];
    if (!node) return results;

    if (node.childNodes && Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) {
        results.push(...this.walkStructure(child, path));
      }
      return results;
    }

    // Leaf part
    const filename = this.structureFilename(node);
    const type = String(node.type ?? '').toLowerCase();
    const isPdf = type === 'application/pdf'
      || (type === 'application/octet-stream' && typeof filename === 'string' && /\.pdf$/i.test(filename))
      || (typeof filename === 'string' && /\.pdf$/i.test(filename));

    results.push({
      part: node.part ?? null,
      type,
      size: Number.isFinite(node.size) ? node.size : null,
      filename,
      disposition: String(node.disposition ?? 'inline').toLowerCase(),
      encoding: typeof node.encoding === 'string' ? node.encoding.toLowerCase() : null,
      isPdf,
    });

    return results;
  }

  async listAttachmentsInFolder({ folder, uid }) {
    const mailbox = validateMailboxPath(folder);
    const numericUid = Number(uid);
    if (!Number.isSafeInteger(numericUid) || numericUid < 1) {
      throw new Error('uid must be a positive integer');
    }

    return this.withReadOnlyClient(async (client) => {
      const fresh = await client.list();
      const allowed = new Set(selectSelectablePaths(fresh, MAX_MAILBOX_LIST));
      if (!allowed.has(mailbox)) {
        throw new Error('mailbox path is not selectable on the current server');
      }

      let lock;
      try {
        lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: LOCK_TIMEOUT_MS });
        const fetched = await client.fetchOne(
          String(numericUid),
          { bodyStructure: true, envelope: true },
          { uid: true },
        );
        if (!fetched) throw new Error('message not found in mailbox');

        const envelope = fetched.envelope;
        const structure = fetched.bodyStructure;

        const allParts = this.walkStructure(structure);
        const attachments = allParts
          .filter((part) => part.disposition === 'attachment' || part.filename !== null)
          .slice(0, MAX_ATTACHMENT_LIST);

        return {
          folder: mailbox,
          uid: numericUid,
          date: envelope?.date instanceof Date ? envelope.date.toISOString() : null,
          from: boundedString(envelope?.from?.[0]?.address ?? '', 256),
          subject: boundedString(envelope?.subject ?? '', 256),
          attachments,
          hasBodyStructure: structure !== undefined,
        };
      } finally {
        lock?.release();
      }
    });
  }

  async fetchAttachmentPart({ folder, uid, part }) {
    const mailbox = validateMailboxPath(folder);
    const numericUid = Number(uid);
    if (!Number.isSafeInteger(numericUid) || numericUid < 1) {
      throw new Error('uid must be a positive integer');
    }
    if (typeof part !== 'string' || !/^\d+(\.\d+)*$/.test(part)) {
      throw new Error('part must be a valid MIME body part number (e.g. "2" or "1.2")');
    }

    return this.withReadOnlyClient(async (client) => {
      const fresh = await client.list();
      const allowed = new Set(selectSelectablePaths(fresh, MAX_MAILBOX_LIST));
      if (!allowed.has(mailbox)) {
        throw new Error('mailbox path is not selectable on the current server');
      }

      let lock;
      try {
        lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: LOCK_TIMEOUT_MS });
        const fetched = await client.fetchOne(
          String(numericUid),
          { bodyStructure: true, bodyParts: [part] },
          { uid: true },
        );
        if (!fetched) throw new Error('message not found in mailbox');

        // Validate the part existed in the body structure
        const allParts = this.walkStructure(fetched.bodyStructure);
        const match = allParts.find((p) => p.part === part);
        if (!match) throw new Error(`body part "${part}" not found in this message`);

        const buffer = fetched.bodyParts?.get(part);
        if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
          throw new Error(`body part "${part}" is empty`);
        }

        // imapflow returns the raw part bytes with the original
        // Content-Transfer-Encoding. Real invoices are base64-encoded, so the
        // %PDF- magic check below would fail on the encoded text; decode here.
        const decoded = decodePartEncoding(buffer, match?.encoding);

        return {
          part,
          type: match.type,
          filename: match.filename,
          size: decoded.length,
          data: decoded,
        };
      } finally {
        lock?.release();
      }
    });
  }

  async fetchBodyInFolder({ folder, uid, redact }) {
    const mailbox = validateMailboxPath(folder);
    const numericUid = Number(uid);
    if (!Number.isSafeInteger(numericUid) || numericUid < 1) {
      throw new Error('uid must be a positive integer');
    }

    const effectiveRedact = redact !== false;

    return this.withReadOnlyClient(async (client) => {
      const fresh = await client.list();
      const allowed = new Set(selectSelectablePaths(fresh, MAX_MAILBOX_LIST));
      if (!allowed.has(mailbox)) {
        throw new Error('mailbox path is not selectable on the current server');
      }

      let lock;
      try {
        lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: LOCK_TIMEOUT_MS });
        const fetched = await client.fetchOne(String(numericUid), { envelope: true, source: { start: 0, maxLength: MAX_LITERAL_BYTES } }, { uid: true });
        if (!fetched) throw new Error('message not found in mailbox');

        const envelope = fetched.envelope;
        const parsed = fetched.source ? parseBoundedLiteral(fetched.source) : { headers: {}, body: '' };
        const date = envelope?.date instanceof Date ? envelope.date.toISOString() : null;
        const from = effectiveRedact
          ? sanitizeExcerpt(envelope?.from?.[0]?.address ?? parsed.headers.from ?? '', 256)
          : boundedString(envelope?.from?.[0]?.address ?? parsed.headers.from ?? '', 256);
        const subject = effectiveRedact
          ? sanitizeExcerpt(envelope?.subject ?? parsed.headers.subject ?? '', 256)
          : boundedString(envelope?.subject ?? parsed.headers.subject ?? '', 256);
        const excerpt = sanitizeExcerpt(parsed.body);

        return {
          folder: mailbox,
          uid: numericUid,
          date,
          from,
          subject,
          excerpt,
        };
      } finally {
        lock?.release();
      }
    });
  }

  async collectMailboxCandidates(client, {
    mailbox,
    from,
    to,
    senderFilter,
    subjectFilter,
    redact,
    limit,
  }) {
    const fresh = await client.list();
    const allowed = new Set(selectSelectablePaths(fresh, MAX_MAILBOX_LIST));
    if (!allowed.has(mailbox)) {
      throw new Error('mailbox path is not selectable on the current server');
    }

    const effectiveRedact = redact !== false;
    const senderNeedle = typeof senderFilter === 'string' ? senderFilter.toLowerCase() : null;
    const subjectNeedle = typeof subjectFilter === 'string' ? subjectFilter.toLowerCase() : null;
    const boundedLimit = Math.min(Math.max(Number(limit) || MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
    // Hostinger advertises the WITHIN extension and rejects WITHIN's "OLDER 0" semantics.
    // ImapFlow emits WITHIN only when the date value is a Date object; passing YYYY-MM-DD
    // strings forces the standard SINCE/BEFORE path and avoids the WITHIN branch entirely.
    const sinceDay = isoDayString(from);
    const beforeDay = isoDayString(new Date(to.getTime() + ONE_DAY_MS));

    let lock;
    try {
      lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: LOCK_TIMEOUT_MS });
      const found = await client.search({ since: sinceDay, before: beforeDay }, { uid: true });
      if (found === false || found === null) throw new Error('IMAP search returned an invalid UID list');
      if (!Array.isArray(found)) throw new Error('IMAP search returned an invalid UID list');
      const sortedUids = found
        .map(Number)
        .filter((uid) => Number.isSafeInteger(uid) && uid >= 1)
        .sort((a, b) => b - a);

      const candidates = [];
      const scanLimit = sortedUids.length;
      for (let index = 0; index < scanLimit && candidates.length < boundedLimit; index += 1) {
        if (candidates.length + (scanLimit - index) > boundedLimit * ENVELOPE_BATCH_MULTIPLIER) break;
        const uid = sortedUids[index];
        const meta = await client.fetchOne(String(uid), { envelope: true, internalDate: true }, { uid: true });
        const envelope = meta?.envelope;
        if (!envelope) continue;
        const sender = envelope.from?.[0]?.address ?? '';
        const subject = envelope.subject ?? '';
        if (senderNeedle && !String(sender).toLowerCase().includes(senderNeedle)) continue;
        if (subjectNeedle && !String(subject).toLowerCase().includes(subjectNeedle)) continue;
        const date = envelope.date instanceof Date
          ? envelope.date.toISOString()
          : (meta?.internalDate instanceof Date ? meta.internalDate.toISOString() : null);
        candidates.push({
          uid,
          internalDate: date,
          from: effectiveRedact ? sanitizeExcerpt(sender, 256) : boundedString(sender, 256),
          subject: effectiveRedact ? sanitizeExcerpt(subject, 256) : boundedString(subject, 256),
        });
      }
      return candidates;
    } finally {
      lock?.release();
    }
  }

  async synchronizeMailbox(client, mailbox) {
    let lock;
    try {
      lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: LOCK_TIMEOUT_MS });
      const uidvalidity = Number(client.mailbox.uidValidity);
      if (!Number.isSafeInteger(uidvalidity) || uidvalidity < 1) throw new Error('IMAP mailbox UIDVALIDITY is invalid');
      const cursor = this.state.getCursor(mailbox);
      const isBootstrap = !cursor || cursor.uidvalidity !== uidvalidity;
      const startUid = isBootstrap ? 1 : cursor.lastUid + 1;
      const bootstrapHighWatermark = isBootstrap ? Number(client.mailbox.uidNext) - 1 : null;
      if (isBootstrap && (!Number.isSafeInteger(bootstrapHighWatermark) || bootstrapHighWatermark < 0)) {
        throw new Error('IMAP mailbox UIDNEXT is invalid during bootstrap');
      }
      const cutoff = isBootstrap ? new Date(this.clock().getTime() - this.bootstrapDays * 24 * 60 * 60 * 1000) : null;
      const searchQuery = isBootstrap
        ? { uid: `1:${bootstrapHighWatermark}`, since: bootstrapSearchDate(cutoff) }
        : { uid: `${startUid}:*` };
      const found = await client.search(searchQuery, { uid: true });
      if (!Array.isArray(found)) throw new Error('IMAP search returned an invalid UID list');
      const uids = found
        .map(Number)
        .filter((uid) => Number.isSafeInteger(uid) && uid >= startUid && (!isBootstrap || uid <= bootstrapHighWatermark))
        .sort((left, right) => left - right);
      let lastUid = startUid - 1;
      for (const uid of uids) {
        const metadata = await client.fetchOne(String(uid), { envelope: true, internalDate: true }, { uid: true });
        if (isBootstrap && (!(metadata?.internalDate instanceof Date) || metadata.internalDate < cutoff)) {
          lastUid = uid;
          continue;
        }
        const messageId = normalizedMessageId(metadata?.envelope?.messageId);
        if (!messageId) {
          this.state.recordAnomaly({ mailbox, uidvalidity, uid, kind: 'message_id_invalid' });
          lastUid = uid;
          continue;
        }
        if (this.state.hasMessageId(messageId)) {
          lastUid = uid;
          continue;
        }
        const fetched = await client.fetchOne(String(uid), {
          source: { start: 0, maxLength: MAX_LITERAL_BYTES },
        }, { uid: true });
        if (!fetched?.source) throw new Error('IMAP source fetch returned no bounded literal');
        const parsed = parseBoundedLiteral(fetched.source);
        const sourceMessageId = normalizedMessageId(parsed.headers['message-id']);
        if (!sourceMessageId || sourceMessageId !== messageId) {
          this.state.recordAnomaly({
            mailbox,
            uidvalidity,
            uid,
            kind: sourceMessageId ? 'message_id_mismatch' : 'message_id_invalid',
          });
          lastUid = uid;
          continue;
        }
        this.state.claimMessage({
          messageId,
          mailbox,
          uidvalidity,
          uid,
          threadKey: normalizedMessageId(parsed.headers.references ?? parsed.headers['in-reply-to'] ?? metadata.envelope.inReplyTo ?? messageId),
          date: metadata.envelope?.date?.toISOString?.() ?? null,
          from: sanitizeExcerpt(metadata.envelope?.from?.[0]?.address ?? '', 256),
          subject: sanitizeExcerpt(metadata.envelope?.subject ?? '', 256),
          sanitizedExcerpt: sanitizeExcerpt(parsed.body),
        });
        lastUid = uid;
      }
      if (isBootstrap) this.state.setCursor(mailbox, uidvalidity, bootstrapHighWatermark);
      else if (lastUid >= startUid) this.state.setCursor(mailbox, uidvalidity, lastUid);
    } finally {
      lock?.release();
    }
  }
}
