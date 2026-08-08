import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  TOOL_NAMES,
  createMailTools,
  createReadOnlyImapClientOptions,
  formatImapToolFailure,
  listSelectableMailboxes,
  sanitizeExcerpt,
  selectSelectablePaths,
  validateDateRange,
  validateFilter,
  validateMailboxPath,
} from '../src/tools.js';
import { ImapIntake, isTransientImapError, readBootstrapDays, selectSyncMailboxes } from '../src/imap-client.js';

const composePath = new URL('../../../docker-compose.yml', import.meta.url);
const configPath = new URL('../../../state/openclaw.json', import.meta.url);

test('exports only the approved bounded read-only mail tools', () => {
  assert.deepEqual(TOOL_NAMES, [
    'mail_list_digest_candidates',
    'mail_get_sanitized_excerpt',
    'mail_get_thread_metadata',
    'mail_list_mailboxes',
    'mail_search_in_mailbox',
    'mail_get_sanitized_in_folder',
    'mail_list_attachments_in_folder',
    'mail_extract_pdf_in_folder',
  ]);
  assert.equal(TOOL_NAMES.some((name) => /send|reply|move|delete|flag|smtp|shell|http/i.test(name)), false);
});

test('requires TLS validation and read-only IMAP configuration', () => {
  const options = createReadOnlyImapClientOptions({ user: 'operator@example.test', pass: 'secret' });
  assert.equal(options.host, 'imap.hostinger.com');
  assert.equal(options.port, 993);
  assert.equal(options.secure, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.disableAutoEnable, true);
  assert.equal(options.maxLiteralSize, 64 * 1024);
  assert.equal(options.qresync, false);
  assert.equal(Object.hasOwn(options, 'smtp'), false);
});

test('bounds and sanitizes mail excerpts without returning raw MIME', () => {
  const excerpt = sanitizeExcerpt(
    'From: sender@example.test\nhttps://private.example.test/x\nCall +34 600 123 456\n' + 'x'.repeat(3000),
    5000,
  );
  assert.equal(excerpt.length, 2000);
  assert.match(excerpt, /\[redacted-email\]/);
  assert.match(excerpt, /\[redacted-url\]/);
  assert.match(excerpt, /\[redacted-phone\]/);
});

test('deduplicates Message-ID and UID candidates and rejects missing Message-ID', async () => {
  const store = new Map();
  const tools = createMailTools({
    state: {
      async listDigestCandidates() {
        return [];
      },
      async getMessage() {
        return null;
      },
      async getThreadMetadata() {
        return [];
      },
      async claimMessage(message) {
        const key = `${message.mailbox}:${message.uidvalidity}:${message.uid}`;
        if (!message.messageId) throw new Error('Message-ID is required');
        if (store.has(key) || [...store.values()].some((entry) => entry.messageId === message.messageId)) return false;
        store.set(key, message);
        return true;
      },
    },
  });
  assert.equal(await tools.recordCandidate({ mailbox: 'INBOX', uidvalidity: 12, uid: 8, messageId: '<a@example.test>' }), true);
  assert.equal(await tools.recordCandidate({ mailbox: 'INBOX', uidvalidity: 12, uid: 8, messageId: '<a@example.test>' }), false);
  assert.equal(await tools.recordCandidate({ mailbox: 'Sent', uidvalidity: 13, uid: 1, messageId: '<a@example.test>' }), false);
  await assert.rejects(() => tools.recordCandidate({ mailbox: 'INBOX', uidvalidity: 12, uid: 9, messageId: '' }), /Message-ID/);
});

test('Compose isolates file credentials and avoids a published port', async () => {
  const compose = await readFile(composePath, 'utf8');
  const sidecar = compose.split('  laia-imap-sidecar:')[1].split('\nnetworks:')[0];
  assert.match(sidecar, /\.\/imap-secrets:\/run\/secrets\/imap-read-only:ro/);
  assert.match(sidecar, /\.\/imap-state:\/var\/lib\/laia-imap/);
  assert.equal(sidecar.includes('ports:'), false);
  assert.match(sidecar, /cap_drop:\n\s+- ALL/);
  assert.match(sidecar, /no-new-privileges:true/);
  assert.match(sidecar, /\/tmp:rw,noexec,nosuid,size=64m/);
  for (const service of ['openclaw-gateway', 'openclaw-cli']) {
    const section = compose.split(`  ${service}:`)[1].split('\n  ')[0];
    assert.equal(section.includes('/run/secrets/imap-read-only'), false);
    assert.equal(section.includes('/var/lib/laia-imap'), false);
  }
});

test('OpenClaw projects only the IMAP read tools', async () => {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(new Set(config.mcp.servers['laia-imap'].toolFilter.include), new Set(TOOL_NAMES));
  assert.equal(config.tools.deny.some((name) => /imap.*(send|reply|move|delete|flag)|smtp/i.test(name)), true);
  assert.deepEqual(
    new Set(config.tools.allow.filter((name) => name.startsWith('laia-imap__'))),
    new Set(TOOL_NAMES.map((name) => `laia-imap__${name}`)),
  );
});

test('the IMAP adapter has no write command surface', async () => {
  const source = await readFile(new URL('../src/imap-client.js', import.meta.url), 'utf8');
  assert.equal(/message(?:Move|Delete|Flags)|mailbox(?:Create|Delete|Rename)|\.append\(/.test(source), false);
  assert.match(source, /readOnly: true/);
  assert.match(source, /fetchOne\(String\(uid\), \{ envelope: true, internalDate: true \}/);
  assert.match(source, /source: \{ start: 0, maxLength: MAX_LITERAL_BYTES \}/);
});

test('defaults the bootstrap window to 30 days and rejects unbounded configuration', () => {
  assert.equal(readBootstrapDays(undefined), 30);
  assert.equal(readBootstrapDays('30'), 30);
  for (const value of ['0', '-1', '1.5', '366', 'nope', ' 30 ']) {
    assert.throws(() => readBootstrapDays(value), /IMAP_BOOTSTRAP_DAYS/);
  }
});

test('selects Inbox and the discovered Sent mailbox without relying on message content', () => {
  const selected = selectSyncMailboxes([
    { path: 'INBOX' },
    { path: 'Archive/Sent', name: 'Sent', specialUse: '\\Sent' },
    { path: 'Localized Sent', name: 'Sent' },
    { path: 'Other', name: 'Other' },
  ]);
  assert.deepEqual(selected.map((mailbox) => mailbox.path), ['INBOX', 'Archive/Sent', 'Localized Sent']);
});

test('bootstraps only internal dates within the cutoff and seeds the cursor at the captured UIDNEXT watermark', async () => {
  const claimed = [];
  const calls = [];
  const state = {
    getCursor: () => null,
    hasMessageId: () => false,
    claimMessage(message) { claimed.push(message); },
    recordAnomaly() {},
    setCursor(mailbox, uidvalidity, uid) { this.cursor = { mailbox, uidvalidity, uid }; },
  };
  const client = {
    mailbox: { uidValidity: 9, uidNext: 9 },
    async getMailboxLock(_mailbox, options) {
      calls.push(['lock', options]);
      return { release() { calls.push(['release']); } };
    },
    async search(query) {
      calls.push(['search', query]);
      return [4, 8];
    },
    async fetchOne(uid, query) {
      calls.push(['fetchOne', uid, query]);
      if (query.envelope) {
        return {
          envelope: { messageId: `<message-${uid}@example.test>`, subject: 'Subject', from: [{ address: 'sender@example.test' }] },
          internalDate: uid === '4' ? new Date('2026-06-20T23:59:59.999Z') : new Date('2026-06-21T00:00:00.000Z'),
        };
      }
      return { source: Buffer.from(`Message-ID: <message-${uid}@example.test>\r\n\r\nPrivate body`) };
    },
  };

  await new ImapIntake({
    state,
    bootstrapDays: 30,
    clock: () => new Date('2026-07-21T00:00:00.000Z'),
  }).synchronizeMailbox(client, 'INBOX');

  assert.deepEqual(calls.find((call) => call[0] === 'search')[1], {
    uid: '1:8',
    since: new Date('2026-06-20T00:00:00.000Z'),
  });
  assert.deepEqual(claimed.map((message) => message.uid), [8]);
  assert.equal(calls.some((call) => call[0] === 'fetchOne' && call[1] === '4' && !call[2].envelope), false);
  assert.deepEqual(state.cursor, { mailbox: 'INBOX', uidvalidity: 9, uid: 8 });
  assert.equal(calls[0][1].readOnly, true);
  assert.equal(calls.at(-1)[0], 'release');
});

test('re-bootstrap after a local cache reset imports all recent Inbox and Sent messages before advancing independent cursors', async () => {
  const claimed = [];
  const cursors = new Map();
  const state = {
    getCursor: (mailbox) => cursors.get(mailbox) ?? null,
    hasMessageId: () => false,
    claimMessage(message) { claimed.push(message); },
    recordAnomaly() {},
    setCursor(mailbox, uidvalidity, lastUid) { cursors.set(mailbox, { uidvalidity, lastUid }); },
  };
  const mailboxUids = {
    INBOX: Array.from({ length: 51 }, (_, index) => index + 1),
    Sent: Array.from({ length: 51 }, (_, index) => index + 1),
  };
  const client = {
    mailbox: {},
    async list() {
      return [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }];
    },
    async getMailboxLock(mailbox) {
      this.mailbox = { uidValidity: mailbox === 'INBOX' ? 9 : 10, uidNext: 52 };
      return { release() {} };
    },
    async search(query) {
      assert.deepEqual(query, { uid: '1:51', since: new Date('2026-06-20T00:00:00.000Z') });
      return mailboxUids[this.mailbox.uidValidity === 9 ? 'INBOX' : 'Sent'];
    },
    async fetchOne(uid, query) {
      const mailbox = this.mailbox.uidValidity === 9 ? 'INBOX' : 'Sent';
      if (query.envelope) {
        return {
          envelope: {
            messageId: `<${mailbox.toLowerCase()}-${uid}@example.test>`,
            subject: 'Subject',
            from: [{ address: 'sender@example.test' }],
          },
          internalDate: new Date('2026-07-21T12:00:00.000Z'),
        };
      }
      return { source: Buffer.from(`Message-ID: <${mailbox.toLowerCase()}-${uid}@example.test>\r\n\r\nPrivate body`) };
    },
  };
  const intake = new ImapIntake({
    state,
    clock: () => new Date('2026-07-21T00:00:00.000Z'),
  });
  await intake.synchronizeMailbox(client, 'INBOX');
  await intake.synchronizeMailbox(client, 'Sent');

  assert.equal(claimed.length, 102);
  assert.equal(claimed.some((message) => message.mailbox === 'INBOX' && message.uid === 51), true);
  assert.equal(claimed.some((message) => message.mailbox === 'Sent' && message.uid === 51), true);
  assert.deepEqual(cursors.get('INBOX'), { uidvalidity: 9, lastUid: 51 });
  assert.deepEqual(cursors.get('Sent'), { uidvalidity: 10, lastUid: 51 });
});

test('polls only post-bootstrap UIDs after the seeded cursor', async () => {
  const claimed = [];
  const state = {
    getCursor: () => ({ uidvalidity: 9, lastUid: 8 }),
    hasMessageId: () => false,
    claimMessage(message) { claimed.push(message); },
    recordAnomaly() {},
    setCursor(mailbox, uidvalidity, uid) { this.cursor = { mailbox, uidvalidity, uid }; },
  };
  const searches = [];
  const client = {
    mailbox: { uidValidity: 9, uidNext: 10 },
    async getMailboxLock() { return { release() {} }; },
    async search(query) { searches.push(query); return [9]; },
    async fetchOne(uid, query) {
      if (query.envelope) {
        return { envelope: { messageId: '<new@example.test>', subject: 'New', from: [{ address: 'sender@example.test' }] } };
      }
      return { source: Buffer.from('Message-ID: <new@example.test>\r\n\r\nPrivate body') };
    },
  };

  await new ImapIntake({ state, clock: () => new Date('2026-07-21T00:00:00.000Z') }).synchronizeMailbox(client, 'INBOX');

  assert.deepEqual(searches, [{ uid: '9:*' }]);
  assert.deepEqual(claimed.map((message) => message.uid), [9]);
  assert.deepEqual(state.cursor, { mailbox: 'INBOX', uidvalidity: 9, uid: 9 });
});

test('polls envelope-first, skips missing and duplicate Message-IDs, and advances the UID cursor', async () => {
  const claimed = [];
  const anomalies = [];
  const known = new Set();
  const state = {
    getCursor: () => null,
    hasMessageId: (messageId) => known.has(messageId),
    claimMessage(message) {
      known.add(message.messageId);
      claimed.push(message);
      return true;
    },
    recordAnomaly(anomaly) {
      anomalies.push(anomaly);
    },
    setCursor(mailbox, uidvalidity, uid) {
      this.cursor = { mailbox, uidvalidity, uid };
    },
  };
  const calls = [];
  const client = {
    mailbox: { uidValidity: 9, uidNext: 4 },
    async getMailboxLock(_mailbox, options) {
      calls.push(['lock', options]);
      return { release() { calls.push(['release']); } };
    },
    async search() {
      return [1, 2, 3];
    },
    async fetchOne(uid, query) {
      calls.push(['fetchOne', uid, query]);
      if (query.envelope) {
        if (uid === '1') return { envelope: { messageId: null }, internalDate: new Date() };
        return {
          envelope: { messageId: '<message-2@example.test>', subject: 'Subject', from: [{ address: 'sender@example.test' }] },
          internalDate: new Date(),
        };
      }
      return { source: Buffer.from('Message-ID: <message-2@example.test>\r\n\r\nPrivate body') };
    },
  };
  const intake = new ImapIntake({ state, clock: () => new Date() });

  await intake.synchronizeMailbox(client, 'INBOX');

  assert.equal(calls[0][1].readOnly, true);
  assert.deepEqual(calls.filter((call) => call[0] === 'fetchOne').map((call) => [call[1], Boolean(call[2].envelope)]), [
    ['1', true], ['2', true], ['2', false], ['3', true],
  ]);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].messageId, '<message-2@example.test>');
  assert.deepEqual(anomalies, [{ mailbox: 'INBOX', uidvalidity: 9, uid: 1, kind: 'message_id_invalid' }]);
  assert.equal(state.cursor.uid, 3);
  assert.equal(calls.at(-1)[0], 'release');
});

test('normalizes equivalent Message-ID presentation and records mismatches without identifiers', async () => {
  const claimed = [];
  const anomalies = [];
  const state = {
    getCursor: () => null,
    hasMessageId: () => false,
    claimMessage(message) {
      claimed.push(message);
      return true;
    },
    recordAnomaly(anomaly) {
      anomalies.push(anomaly);
    },
    setCursor(mailbox, uidvalidity, uid) {
      this.cursor = { mailbox, uidvalidity, uid };
    },
  };
  const client = {
    mailbox: { uidValidity: 10, uidNext: 3 },
    async getMailboxLock() {
      return { release() {} };
    },
    async search() {
      return [1, 2];
    },
    async fetchOne(uid, query) {
      if (query.envelope) {
        return {
          envelope: {
            messageId: uid === '1' ? ' <Provider-42@Example.TEST> ' : '<provider-43@example.test>',
            subject: 'Subject',
            from: [{ address: 'sender@example.test' }],
          },
          internalDate: new Date(),
        };
      }
      return {
        source: Buffer.from(
          uid === '1'
            ? 'Message-ID:\r\n <provider-42@example.test>\r\n\r\nBody'
            : 'Message-ID: <different@example.test>\r\n\r\nBody',
        ),
      };
    },
  };

  await new ImapIntake({ state }).synchronizeMailbox(client, 'INBOX');

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].messageId, '<provider-42@example.test>');
  assert.deepEqual(anomalies, [{ mailbox: 'INBOX', uidvalidity: 10, uid: 2, kind: 'message_id_mismatch' }]);
  assert.deepEqual(state.cursor, { mailbox: 'INBOX', uidvalidity: 10, uid: 2 });
});

test('listSelectableMailboxes filters \\Noselect and \\NonExistent and bounds the output', () => {
  const result = listSelectableMailboxes([
    { path: 'INBOX', name: 'Inbox' },
    { path: 'Sent', name: 'Sent', flags: new Set(['\\Sent']) },
    { path: 'Drafts', name: 'Drafts', flags: new Set(['\\Drafts', '\\Noselect']) },
    { path: 'Hidden', name: 'Hidden', flags: { '\\NonExistent': true } },
    { path: 'Other', name: 'Other', flags: { '\\Noselect': true } },
    { path: '', name: 'Empty' },
    { flags: new Set(['\\Sent']) },
  ]);
  assert.deepEqual(result, [
    { path: 'INBOX', name: 'Inbox' },
    { path: 'Sent', name: 'Sent' },
  ]);
});

test('listSelectableMailboxes bounds to 200 selectable entries even when more exist', () => {
  const mailboxes = Array.from({ length: 500 }, (_, index) => ({ path: `Folder${index}`, name: `Folder${index}` }));
  const result = listSelectableMailboxes(mailboxes);
  assert.equal(result.length, 200);
});

test('selectSelectablePaths returns raw paths for the fresh-list allowlist', () => {
  const paths = selectSelectablePaths([
    { path: 'INBOX', name: 'Inbox' },
    { path: 'Sent', name: 'Sent', flags: new Set(['\\Sent']) },
    { path: 'Drafts', name: 'Drafts', flags: new Set(['\\Noselect']) },
  ]);
  assert.deepEqual(paths, ['INBOX', 'Sent']);
});

test('validateMailboxPath rejects controls, wildcards, bad length, and non-strings', () => {
  for (const value of ['', 'A'.repeat(257), 'INBOX\x00', 'INBOX*', 'INBOX%', 'INBOX\n', 'INBOX\r', null, undefined, 42]) {
    assert.throws(() => validateMailboxPath(value), /mailbox/);
  }
  for (const value of ['INBOX', 'Archive/Sent:2024', 'INBOX.Sub-Folder', 'Unwanted/No Deseado']) {
    assert.equal(validateMailboxPath(value), value);
  }
});

test('validateDateRange rejects malformed dates, inverted ranges, and > 366 days', () => {
  assert.throws(() => validateDateRange('not-a-date', '2026-07-21'), /YYYY-MM-DD/);
  assert.throws(() => validateDateRange('2026-13-01', '2026-07-21'), /valid date/);
  assert.throws(() => validateDateRange('2026-02-30', '2026-07-21'), /valid date/);
  assert.throws(() => validateDateRange('2026-07-21', '2026-07-20'), /on or before/);
  assert.throws(() => validateDateRange('2025-01-01', '2026-07-21'), /366 days/);
  const range = validateDateRange('2026-01-01', '2026-12-31');
  assert.equal(range.from.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(range.to.toISOString(), '2026-12-31T00:00:00.000Z');
});

test('validateDateRange accepts exactly 366 days and rejects 367 days', () => {
  assert.doesNotThrow(() => validateDateRange('2026-01-01', '2027-01-02'));
  assert.throws(() => validateDateRange('2026-01-01', '2027-01-03'), /366 days/);
});

test('validateFilter rejects controls and over-length strings but accepts undefined', () => {
  assert.equal(validateFilter(undefined, 'senderFilter'), undefined);
  assert.equal(validateFilter(null, 'subjectFilter'), undefined);
  assert.equal(validateFilter('boss@example.test', 'senderFilter'), 'boss@example.test');
  assert.throws(() => validateFilter('A'.repeat(257), 'senderFilter'), /256/);
  assert.throws(() => validateFilter('hello\x00', 'senderFilter'), /control/);
});

test('ImapIntake.collectMailboxesFromClient returns sanitized selectable paths', async () => {
  const client = {
    async list() {
      return [
        { path: 'INBOX', name: 'Inbox' },
        { path: 'Sent', name: 'Sent', flags: new Set(['\\Sent']) },
        { path: 'Drafts', name: 'Drafts', flags: new Set(['\\Noselect']) },
        { path: 'Unwanted/No Deseado', name: 'No Deseado' },
      ];
    },
  };
  const result = await new ImapIntake({ state: {} }).collectMailboxesFromClient(client, 200);
  assert.deepEqual(result, [
    { path: 'INBOX', name: 'Inbox' },
    { path: 'Sent', name: 'Sent' },
    { path: 'Unwanted/No Deseado', name: 'No Deseado' },
  ]);
});

test('ImapIntake.collectMailboxesFromClient bounds the result to the requested limit', async () => {
  const client = {
    async list() {
      return Array.from({ length: 500 }, (_, index) => ({ path: `Folder${index}`, name: `Folder${index}` }));
    },
  };
  const result = await new ImapIntake({ state: {} }).collectMailboxesFromClient(client, 200);
  assert.equal(result.length, 200);
});

test('ImapIntake.listMailboxes opens and closes the read-only client and returns the inner result', async () => {
  const lifecycle = [];
  const FakeImapFlow = class {
    constructor() {}
    async connect() { lifecycle.push('connect'); }
    async list() {
      lifecycle.push('list');
      return [
        { path: 'INBOX', name: 'Inbox' },
        { path: 'Sent', name: 'Sent', flags: new Set(['\\Sent']) },
      ];
    }
    async logout() { lifecycle.push('logout'); }
  };
  const intake = new ImapIntake({
    state: {},
    ImapFlowImpl: FakeImapFlow,
    loadCredentials: async () => ({ user: 'test', pass: 'test' }),
  });
  const result = await intake.listMailboxes();
  assert.deepEqual(result, [
    { path: 'INBOX', name: 'Inbox' },
    { path: 'Sent', name: 'Sent' },
  ]);
  assert.deepEqual(lifecycle, ['connect', 'list', 'logout']);
});

test('searchMailbox acquires a read-only lock and releases it on the happy path', async () => {
  const calls = [];
  const client = {
    async list() {
      return [{ path: 'INBOX', name: 'Inbox' }, { path: 'Unwanted/No Deseado', name: 'No Deseado' }];
    },
    async getMailboxLock(mailbox, options) {
      calls.push(['lock', mailbox, options]);
      return { release() { calls.push(['release']); } };
    },
    async search(query) {
      calls.push(['search', query]);
      return [];
    },
    async fetchOne() { return null; },
  };
  await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'Unwanted/No Deseado',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: true,
    limit: 20,
  });
  assert.equal(calls[0][0], 'lock');
  assert.equal(calls[0][1], 'Unwanted/No Deseado');
  assert.equal(calls[0][2].readOnly, true);
  assert.equal(calls.at(-1)[0], 'release');
});

test('searchMailbox releases the read-only lock even when the search throws', async () => {
  const calls = [];
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() {
      return { release() { calls.push(['release']); } };
    },
    async search() {
      throw new Error('IMAP server unavailable');
    },
  };
  await assert.rejects(
    new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
      mailbox: 'INBOX',
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-21T00:00:00.000Z'),
      redact: true,
      limit: 20,
    }),
    /IMAP/,
  );
  assert.equal(calls.at(-1)[0], 'release');
});

test('searchMailbox fetches only envelope and internalDate, never source/MIME/body', async () => {
  const fetched = [];
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search() { return [7]; },
    async fetchOne(uid, query) {
      fetched.push([uid, query]);
      return {
        envelope: {
          subject: 'Subject',
          from: [{ address: 'sender@example.test' }],
          date: new Date('2026-07-15T00:00:00.000Z'),
        },
        internalDate: new Date('2026-07-15T00:00:00.000Z'),
      };
    },
  };
  const result = await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: true,
    limit: 20,
  });
  assert.equal(fetched.length, 1);
  assert.deepEqual(fetched[0][1], { envelope: true, internalDate: true });
  assert.equal(Object.hasOwn(fetched[0][1], 'source'), false);
  assert.equal(Object.hasOwn(fetched[0][1], 'body'), false);
  assert.equal(result.length, 1);
  assert.equal(result[0].uid, 7);
});

test('searchMailbox uses a date-only IMAP search and never passes TEXT or BODY criteria', async () => {
  const searchArgs = [];
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search(query) {
      searchArgs.push(query);
      return [];
    },
    async fetchOne() { return null; },
  };
  await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: true,
    limit: 20,
  });
  assert.equal(searchArgs.length, 1);
  assert.deepEqual(Object.keys(searchArgs[0]).sort(), ['before', 'since']);
  assert.equal(Object.hasOwn(searchArgs[0], 'text'), false);
  assert.equal(Object.hasOwn(searchArgs[0], 'body'), false);
});

test('searchMailbox applies the subject filter only after envelope fetch', async () => {
  const searchArgs = [];
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search(query) {
      searchArgs.push(query);
      return [3, 2, 1];
    },
    async fetchOne(uid) {
      const subjects = { 1: 'hello world', 2: 'invoice march', 3: 'INVOICE #123' };
      return {
        envelope: {
          subject: subjects[uid],
          from: [{ address: 'sender@example.test' }],
          date: new Date('2026-07-15T00:00:00.000Z'),
        },
        internalDate: new Date('2026-07-15T00:00:00.000Z'),
      };
    },
  };
  const result = await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    subjectFilter: 'invoice',
    redact: true,
    limit: 20,
  });
  assert.deepEqual(result.map((entry) => entry.uid), [3, 2]);
  for (const query of searchArgs) {
    assert.equal(Object.hasOwn(query, 'text'), false);
    assert.equal(Object.hasOwn(query, 'subject'), false);
  }
});

test('searchMailbox applies the sender filter at envelope level and not via IMAP FROM search', async () => {
  const searchArgs = [];
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search(query) {
      searchArgs.push(query);
      return [2, 1];
    },
    async fetchOne(uid) {
      const senders = { 1: 'boss@example.test', 2: 'other@example.test' };
      return {
        envelope: {
          subject: 'Subject',
          from: [{ address: senders[uid] }],
          date: new Date('2026-07-15T00:00:00.000Z'),
        },
        internalDate: new Date('2026-07-15T00:00:00.000Z'),
      };
    },
  };
  const result = await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    senderFilter: 'boss',
    redact: true,
    limit: 20,
  });
  assert.deepEqual(result.map((entry) => entry.uid), [1]);
  for (const query of searchArgs) {
    assert.equal(Object.hasOwn(query, 'from'), false);
  }
});

test('searchMailbox rejects mailbox paths that are not in the fresh server list', async () => {
  let locked = false;
  const client = {
    async list() {
      return [
        { path: 'INBOX', name: 'Inbox' },
        { path: 'Sent', name: 'Sent', flags: new Set(['\\Sent']) },
      ];
    },
    async getMailboxLock() {
      locked = true;
      return { release() {} };
    },
    async search() { return []; },
  };
  await assert.rejects(
    new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
      mailbox: 'Unwanted',
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-21T00:00:00.000Z'),
      redact: true,
      limit: 20,
    }),
    /not selectable/,
  );
  assert.equal(locked, false);
});

test('searchMailbox redacts sender and subject by default and exposes them when redact is false', async () => {
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search() { return [1]; },
    async fetchOne() {
      return {
        envelope: {
          subject: 'Confidential invoice from boss@example.test',
          from: [{ address: 'boss@example.test' }],
          date: new Date('2026-07-15T00:00:00.000Z'),
        },
        internalDate: new Date('2026-07-15T00:00:00.000Z'),
      };
    },
  };
  const intake = new ImapIntake({ state: {} });
  const redacted = await intake.collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: true,
    limit: 20,
  });
  assert.match(redacted[0].from, /\[redacted-email\]/);
  assert.match(redacted[0].subject, /\[redacted-email\]/);
  const raw = await intake.collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: false,
    limit: 20,
  });
  assert.equal(raw[0].from, 'boss@example.test');
  assert.equal(raw[0].subject, 'Confidential invoice from boss@example.test');
});

test('searchMailbox defaults redact to true when not specified', async () => {
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search() { return [1]; },
    async fetchOne() {
      return {
        envelope: {
          subject: 'Boss contact boss@example.test',
          from: [{ address: 'boss@example.test' }],
          date: new Date('2026-07-15T00:00:00.000Z'),
        },
        internalDate: new Date('2026-07-15T00:00:00.000Z'),
      };
    },
  };
  const result = await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    limit: 20,
  });
  assert.match(result[0].from, /\[redacted-email\]/);
});

test('searchMailbox caps the result list at the requested limit and sorts UIDs newest first', async () => {
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search() { return [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]; },
    async fetchOne(uid) {
      return {
        envelope: {
          subject: `Subject ${uid}`,
          from: [{ address: `sender-${uid}@example.test` }],
          date: new Date('2026-07-15T00:00:00.000Z'),
        },
        internalDate: new Date('2026-07-15T00:00:00.000Z'),
      };
    },
  };
  const result = await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: false,
    limit: 5,
  });
  assert.equal(result.length, 5);
  assert.deepEqual(result.map((entry) => entry.uid), [10, 9, 8, 7, 6]);
});

test('searchMailbox exposes an internalDate derived from the envelope when available', async () => {
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search() { return [1]; },
    async fetchOne() {
      return {
        envelope: {
          subject: 'Subject',
          from: [{ address: 'sender@example.test' }],
          date: new Date('2026-07-15T10:20:30.000Z'),
        },
        internalDate: new Date('2026-07-15T10:20:31.000Z'),
      };
    },
  };
  const result = await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: false,
    limit: 20,
  });
  assert.equal(result[0].internalDate, '2026-07-15T10:20:30.000Z');
});

test('searchMailbox sends YYYY-MM-DD string criteria (not Date objects) with { uid: true } so ImapFlow uses standard SINCE/BEFORE instead of WITHIN', async () => {
  const searchCalls = [];
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search(query, options) {
      searchCalls.push({ query, options });
      return [];
    },
    async fetchOne() { return null; },
  };
  await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: true,
    limit: 20,
  });
  assert.equal(searchCalls.length, 1);
  assert.equal(typeof searchCalls[0].query.since, 'string', 'since must be a string to avoid ImapFlow WITHIN extension');
  assert.equal(typeof searchCalls[0].query.before, 'string', 'before must be a string to avoid ImapFlow WITHIN extension');
  assert.equal(searchCalls[0].query.since, '2026-07-01');
  assert.equal(searchCalls[0].query.before, '2026-07-22', 'before must be the exclusive next day as YYYY-MM-DD');
  assert.equal(searchCalls[0].options.uid, true);
  assert.equal(searchCalls[0].query.since instanceof Date, false);
  assert.equal(searchCalls[0].query.before instanceof Date, false);
});

test('searchMailbox treats false from client.search as a fail-closed error and never calls fetchOne', async () => {
  const fetchCalls = [];
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search() { return false; },
    async fetchOne(uid, query) { fetchCalls.push([uid, query]); return null; },
  };
  await assert.rejects(
    new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
      mailbox: 'INBOX',
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-21T00:00:00.000Z'),
      redact: true,
      limit: 20,
    }),
    /invalid UID list/,
  );
  assert.equal(fetchCalls.length, 0, 'fetchOne must not run when client.search returns false');
});

test('searchMailbox treats [] from client.search as a successful no-match and never calls fetchOne', async () => {
  const fetchCalls = [];
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search() { return []; },
    async fetchOne(uid, query) { fetchCalls.push([uid, query]); return null; },
  };
  const result = await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: true,
    limit: 20,
  });
  assert.deepEqual(result, []);
  assert.equal(fetchCalls.length, 0, 'fetchOne must not run when client.search returns []');
});

test('searchMailbox rejects malformed non-array responses from client.search without calling fetchOne', async () => {
  for (const value of [null, undefined, 'oops', 42, { uid: 1 }, true]) {
    const fetchCalls = [];
    const client = {
      async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
      async getMailboxLock() { return { release() {} }; },
      async search() { return value; },
      async fetchOne() { fetchCalls.push(true); return null; },
    };
    await assert.rejects(
      new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
        mailbox: 'INBOX',
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-21T00:00:00.000Z'),
        redact: true,
        limit: 20,
      }),
      /invalid UID list/,
      `malformed response ${JSON.stringify(value)} must reject`,
    );
    assert.equal(fetchCalls.length, 0, `fetchOne must not run when client.search returns ${JSON.stringify(value)}`);
  }
});

test('searchMailbox translates the date range into IMAP SINCE and exclusive BEFORE', async () => {
  const searchArgs = [];
  const client = {
    async list() { return [{ path: 'INBOX', name: 'Inbox' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search(query) {
      searchArgs.push(query);
      return [];
    },
    async fetchOne() { return null; },
  };
  await new ImapIntake({ state: {} }).collectMailboxCandidates(client, {
    mailbox: 'INBOX',
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-21T00:00:00.000Z'),
    redact: true,
    limit: 20,
  });
  assert.equal(searchArgs[0].since, '2026-07-01');
  assert.equal(searchArgs[0].before, '2026-07-22');
});

test('ImapIntake.searchMailbox rejects malformed inputs before opening a connection', async () => {
  let opened = false;
  const FakeImapFlow = class {
    constructor() { opened = true; }
    async connect() {}
    async list() { return []; }
    async logout() {}
  };
  const intake = new ImapIntake({ state: {}, ImapFlowImpl: FakeImapFlow });
  await assert.rejects(intake.searchMailbox({ mailbox: 'INBOX*' }), /forbidden/);
  await assert.rejects(
    intake.searchMailbox({
      mailbox: 'INBOX',
      fromDate: 'not-a-date',
      toDate: '2026-07-21',
    }),
    /YYYY-MM-DD/,
  );
  await assert.rejects(
    intake.searchMailbox({
      mailbox: 'INBOX',
      fromDate: '2025-01-01',
      toDate: '2026-07-21',
    }),
    /366 days/,
  );
  await assert.rejects(
    intake.searchMailbox({ mailbox: 'INBOX', fromDate: '2026-07-21', toDate: '2026-07-20' }),
    /on or before/,
  );
  assert.equal(opened, false);
});

test('mail_search_in_mailbox never references IMAP TEXT, BODY, or fetchOne source in source', async () => {
  const source = await readFile(new URL('../src/imap-client.js', import.meta.url), 'utf8');
  const match = source.match(/async collectMailboxCandidates\([\s\S]*?\n  \}/);
  assert.ok(match, 'collectMailboxCandidates method must be present');
  const section = match[0];
  assert.equal(/\btext\s*:/.test(section), false, 'IMAP search must not receive text:');
  assert.equal(/\bbody\s*:/.test(section), false, 'IMAP search must not receive body:');
  assert.equal(/\bsource\s*:/.test(section), false, 'fetchOne must not request source/MIME/body');
});

test('searchMailbox facade forwards fromDate/toDate strings to intake and does not forward from/to Date objects', async () => {
  const intakeCalls = [];
  const tools = createMailTools({
    intake: {
      async searchMailbox(input) {
        intakeCalls.push(input);
        return [];
      },
    },
  });
  await tools.searchMailbox({
    mailbox: 'INBOX',
    fromDate: '2026-07-01',
    toDate: '2026-07-21',
    redact: true,
    limit: 5,
  });
  assert.equal(intakeCalls.length, 1);
  assert.equal(intakeCalls[0].fromDate, '2026-07-01');
  assert.equal(intakeCalls[0].toDate, '2026-07-21');
  assert.equal(Object.hasOwn(intakeCalls[0], 'from'), false, 'facade must not forward from Date object to intake');
  assert.equal(Object.hasOwn(intakeCalls[0], 'to'), false, 'facade must not forward to Date object to intake');
  assert.equal(typeof intakeCalls[0].fromDate, 'string');
  assert.equal(typeof intakeCalls[0].toDate, 'string');
  assert.equal(intakeCalls[0].mailbox, 'INBOX');
  assert.equal(intakeCalls[0].redact, true);
  assert.equal(intakeCalls[0].limit, 5);
});

test('searchMailbox facade keeps intake-side date validation authoritative (range, format, inversion)', async () => {
  const tools = createMailTools({
    intake: {
      async searchMailbox(input) {
        const { from, to } = validateDateRange(input.fromDate, input.toDate);
        return { from: from.toISOString(), to: to.toISOString() };
      },
    },
  });
  await assert.rejects(
    tools.searchMailbox({ mailbox: 'INBOX', fromDate: 'not-a-date', toDate: '2026-07-21' }),
    /YYYY-MM-DD/,
  );
  await assert.rejects(
    tools.searchMailbox({ mailbox: 'INBOX', fromDate: '2025-01-01', toDate: '2026-07-21' }),
    /366 days/,
  );
  await assert.rejects(
    tools.searchMailbox({ mailbox: 'INBOX', fromDate: '2026-07-21', toDate: '2026-07-20' }),
    /on or before/,
  );
  const ok = await tools.searchMailbox({
    mailbox: 'INBOX',
    fromDate: '2026-07-01',
    toDate: '2026-07-21',
  });
  assert.equal(ok.from, '2026-07-01T00:00:00.000Z');
  assert.equal(ok.to, '2026-07-21T00:00:00.000Z');
});

test('searchMailbox facade still validates mailbox path, filter, and limit before delegating', async () => {
  const intakeCalls = [];
  const tools = createMailTools({
    intake: {
      async searchMailbox(input) {
        intakeCalls.push(input);
        return [];
      },
    },
  });
  await assert.rejects(tools.searchMailbox({ mailbox: 'INBOX*' }), /forbidden/);
  await assert.rejects(
    tools.searchMailbox({ mailbox: 'INBOX', fromDate: '2026-07-01', toDate: '2026-07-21', senderFilter: 7 }),
    /senderFilter/,
  );
  await tools.searchMailbox({ mailbox: 'INBOX', fromDate: '2026-07-01', toDate: '2026-07-21', limit: 999 });
  assert.equal(intakeCalls.length, 1);
  assert.equal(intakeCalls[0].limit, 20, 'facade must clamp over-limit limit to MAX_SEARCH_RESULTS (20)');
  assert.equal(intakeCalls[0].redact, true, 'facade must default redact to true');
  await tools.searchMailbox({
    mailbox: 'INBOX',
    fromDate: '2026-07-01',
    toDate: '2026-07-21',
    redact: false,
  });
  assert.equal(intakeCalls[1].redact, false);
});

test('formatImapToolFailure logs the static error message and a generic response envelope', () => {
  const out = formatImapToolFailure('mail_search_in_mailbox', new Error('IMAP search returned an invalid UID list'));
  assert.equal(out.log.event, 'imap_tool_failure');
  assert.equal(out.log.tool, 'mail_search_in_mailbox');
  assert.equal(out.log.error, 'Error');
  assert.equal(out.log.message, 'IMAP search returned an invalid UID list');
  assert.equal(out.response.isError, true);
  assert.equal(out.response.content[0].text, 'IMAP read-only intake is unavailable.');
  // Non-Error inputs still produce a log line.
  const fallback = formatImapToolFailure('mail_list_mailboxes', 'plain failure');
  assert.equal(fallback.log.error, 'String');
  assert.equal(fallback.log.message, undefined);
  // Objects without a message field still produce a log without message.
  const noMessage = formatImapToolFailure('mail_list_mailboxes', { foo: 'bar' });
  assert.equal(noMessage.log.error, 'Object');
  assert.equal(noMessage.log.message, undefined);
});

test('isTransientImapError classifies network and IMAP overload errors as retriable', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND']) {
    assert.equal(isTransientImapError({ code }), true, `expected ${code} to be transient`);
  }
  assert.equal(isTransientImapError({ responseStatus: 'TOO_MANY_CONNECTIONS' }), true);
  assert.equal(isTransientImapError({ responseText: 'try again later' }), true);
  assert.equal(isTransientImapError({ message: 'rate limit exceeded' }), true);
  assert.equal(isTransientImapError({ message: 'throttled, retry' }), true);
  // Permanent errors are NOT retried.
  assert.equal(isTransientImapError(new Error('mailbox path is not selectable on the current server')), false);
  assert.equal(isTransientImapError(new Error('message not found')), false);
  assert.equal(isTransientImapError({ responseStatus: 'NO' }), false);
  assert.equal(isTransientImapError(null), false);
});

test('withReadOnlyClient retries transient failures and eventually succeeds', async () => {
  let attempts = 0;
  const intake = new ImapIntake({
    state: {},
    loadCredentials: async () => ({ user: 'u', pass: 'p' }),
    ImapFlowImpl: class {
      constructor() { this.connected = false; }
      async connect() {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('rate limit exceeded'), { code: 'ETIMEDOUT' });
        this.connected = true;
      }
      async logout() { this.connected = false; }
      async close() { this.connected = false; }
    },
  });
  const result = await intake.withReadOnlyClient(async (client) => {
    assert.equal(client.connected, true);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3, 'must have retried until the third attempt succeeded');
});

test('withReadOnlyClient surfaces permanent failures without retry', async () => {
  let attempts = 0;
  const intake = new ImapIntake({
    state: {},
    loadCredentials: async () => ({ user: 'u', pass: 'p' }),
    ImapFlowImpl: class {
      async connect() { attempts += 1; }
      async logout() {}
      async close() {}
    },
  });
  await assert.rejects(
    intake.withReadOnlyClient(async () => { throw new Error('mailbox path is not selectable on the current server'); }),
    /mailbox path is not selectable/,
  );
  assert.equal(attempts, 1, 'connect is called once and the permanent worker error is not retried');
});

test('withReadOnlyClient gives up after MAX_CONNECT_ATTEMPTS on persistent transient failures', async () => {
  let attempts = 0;
  const intake = new ImapIntake({
    state: {},
    loadCredentials: async () => ({ user: 'u', pass: 'p' }),
    ImapFlowImpl: class {
      async connect() { attempts += 1; throw Object.assign(new Error('rate limit exceeded'), { code: 'ETIMEDOUT' }); }
      async logout() {}
      async close() {}
    },
  });
  const start = Date.now();
  await assert.rejects(intake.withReadOnlyClient(async () => 'ok'), /rate limit/);
  const elapsed = Date.now() - start;
  assert.equal(attempts, 3, 'must attempt exactly MAX_CONNECT_ATTEMPTS times');
  assert.ok(elapsed >= 500 + 1000, `must back off at least once (got ${elapsed}ms)`);
  assert.ok(elapsed < 4000, `must not exceed the backoff cap (got ${elapsed}ms)`);
});

function mockFetchBodyClient(handlers = {}) {
  const MockImapFlow = class {
    async connect() {}
    async list() { return handlers.list?.() ?? [{ path: 'INBOX', name: 'Inbox' }]; }
    async getMailboxLock() { return handlers.getMailboxLock?.() ?? { release() {} }; }
    async fetchOne(...args) { return handlers.fetchOne?.(...args) ?? null; }
    async logout() {}
    async close() {}
  };
  return new ImapIntake({
    state: {},
    ImapFlowImpl: MockImapFlow,
    loadCredentials: async () => ({ user: 'test', pass: 'test' }),
  });
}

test('fetchBodyInFolder returns sanitized body text and metadata for a valid folder and uid', async () => {
  const intake = mockFetchBodyClient({
    list: () => [{ path: 'INBOX.Vitifrigo', name: 'Vitifrigo' }],
    fetchOne(uid, query) {
      assert.equal(uid, '42');
      assert.deepEqual(query, { envelope: true, source: { start: 0, maxLength: 64 * 1024 } });
      return {
        envelope: {
          subject: 'Envío de E-Factura 2024-005',
          from: [{ address: 'facturas@vitifrigo.test' }],
          date: new Date('2024-05-23T10:30:00.000Z'),
        },
        source: Buffer.from(
          'Message-ID: <msg-42@vitifrigo.test>\r\n'
          + 'From: facturas@vitifrigo.test\r\n'
          + 'Subject: Envío de E-Factura 2024-005\r\n'
          + '\r\n'
          + 'Hola Javier,\r\n'
          + '\r\n'
          + 'Adjuntamos la factura 2024-005 por importe de 1.234,56€.\r\n'
          + 'Puede descargarla en https://facturas.vitifrigo.test/2024-005\r\n'
          + 'Contacto: cobros@vitifrigo.test / +34 928 123 456\r\n'
        ),
      };
    },
  });
  const result = await intake.fetchBodyInFolder({ folder: 'INBOX.Vitifrigo', uid: 42 });
  assert.equal(result.folder, 'INBOX.Vitifrigo');
  assert.equal(result.uid, 42);
  assert.equal(result.date, '2024-05-23T10:30:00.000Z');
  // default redact: true redacts metadata
  assert.equal(result.from, '[redacted-email]');
  assert.equal(result.subject, 'Envío de E-Factura 2024-005');
  assert.match(result.excerpt, /Adjuntamos la factura 2024-005/);
  assert.match(result.excerpt, /\[redacted-url\]/);
  assert.match(result.excerpt, /\[redacted-email\]/);
  assert.match(result.excerpt, /\[redacted-phone\]/);
  // explicit redact: false returns raw values
  const raw = await intake.fetchBodyInFolder({ folder: 'INBOX.Vitifrigo', uid: 42, redact: false });
  assert.equal(raw.from, 'facturas@vitifrigo.test');
});

test('fetchBodyInFolder acquires a read-only lock and releases it on the happy path', async () => {
  const calls = [];
  const intake = mockFetchBodyClient({
    list: () => [{ path: 'INBOX.Vitifrigo', name: 'Vitifrigo' }],
    getMailboxLock: () => {
      return { release() { calls.push(['release']); } };
    },
    fetchOne() {
      calls.push(['lock', 'INBOX.Vitifrigo', { readOnly: true }]);
      return {
        envelope: { subject: 'T', from: [{ address: 'a@b.test' }], date: new Date() },
        source: Buffer.from('\r\n\r\nBody'),
      };
    },
  });
  await intake.fetchBodyInFolder({ folder: 'INBOX.Vitifrigo', uid: 1 });
  assert.equal(calls[0][0], 'lock');
  assert.equal(calls[0][1], 'INBOX.Vitifrigo');
  assert.equal(calls[0][2].readOnly, true);
  assert.equal(calls.at(-1)[0], 'release');
});

test('fetchBodyInFolder releases the lock even when fetchOne returns null', async () => {
  const calls = [];
  const intake = mockFetchBodyClient({
    list: () => [{ path: 'INBOX.Vitifrigo', name: 'Vitifrigo' }],
    getMailboxLock: () => {
      return { release() { calls.push(['release']); } };
    },
    fetchOne() { return null; },
  });
  await assert.rejects(intake.fetchBodyInFolder({ folder: 'INBOX.Vitifrigo', uid: 1 }), /message not found/);
  assert.equal(calls.at(-1)[0], 'release');
});

test('fetchBodyInFolder rejects a folder that is not in the selectable path list', async () => {
  const intake = mockFetchBodyClient({
    list: () => [{ path: 'INBOX', name: 'Inbox' }],
  });
  await assert.rejects(intake.fetchBodyInFolder({ folder: 'INBOX.Vitifrigo', uid: 1 }), /mailbox path is not selectable/);
});

test('fetchBodyInFolder rejects an invalid uid', async () => {
  const intake = mockFetchBodyClient();
  await assert.rejects(intake.fetchBodyInFolder({ folder: 'INBOX', uid: -1 }), /uid must be a positive integer/);
  await assert.rejects(intake.fetchBodyInFolder({ folder: 'INBOX', uid: 0 }), /uid must be a positive integer/);
});

test('fetchBodyInFolder handles missing source gracefully (no body available)', async () => {
  const intake = mockFetchBodyClient({
    fetchOne() {
      return {
        envelope: { subject: 'T', from: [{ address: 'a@b.test' }], date: new Date() },
        source: undefined,
      };
    },
  });
  const result = await intake.fetchBodyInFolder({ folder: 'INBOX', uid: 1 });
  assert.equal(result.excerpt, '');
});

test('getSanitizedInFolder facade validates folder path and delegates to intake', async () => {
  let called = false;
  const tools = createMailTools({
    state: {},
    intake: {
      async fetchBodyInFolder({ folder, uid }) {
        called = true;
        assert.equal(folder, 'INBOX.Vitifrigo');
        assert.equal(uid, 42);
        return { folder, uid, excerpt: 'test' };
      },
    },
  });
  const result = await tools.getSanitizedInFolder({ folder: 'INBOX.Vitifrigo', uid: 42 });
  assert.equal(called, true);
  assert.equal(result.excerpt, 'test');
});

test('getSanitizedInFolder facade rejects invalid folder path', async () => {
  const tools = createMailTools({ state: {}, intake: { fetchBodyInFolder: async () => ({}) } });
  await assert.rejects(tools.getSanitizedInFolder({ folder: 'INBOX*', uid: 1 }), /forbidden/);
  await assert.rejects(tools.getSanitizedInFolder({ folder: '', uid: 1 }), /mailbox length/);
  await assert.rejects(tools.getSanitizedInFolder({ folder: 'INBOX', uid: 0 }), /positive integer/);
  await assert.rejects(tools.getSanitizedInFolder({ folder: 'INBOX', uid: -5 }), /positive integer/);
});

test('getSanitizedInFolder facade throws when intake is not configured', async () => {
  const tools = createMailTools({ state: {} });
  await assert.rejects(tools.getSanitizedInFolder({ folder: 'INBOX', uid: 1 }), /IMAP intake is not configured/);
});

// ── Attachment listing ──────────────────────────────────────────────────────

function mockAttachmentClient(handlers = {}) {
  const MockImapFlow = class {
    async connect() {}
    async list() { return handlers.list?.() ?? [{ path: 'INBOX', name: 'Inbox' }]; }
    async getMailboxLock() { return handlers.getMailboxLock?.() ?? { release() {} }; }
    async fetchOne(...args) { return handlers.fetchOne?.(...args) ?? null; }
    async logout() {}
    async close() {}
  };
  return new ImapIntake({
    state: {},
    ImapFlowImpl: MockImapFlow,
    loadCredentials: async () => ({ user: 'test', pass: 'test' }),
  });
}

test('listAttachmentsInFolder walks bodyStructure and returns PDF attachments when present', async () => {
  const intake = mockAttachmentClient({
    list: () => [{ path: 'INBOX.Vitifrigo', name: 'Vitifrigo' }],
    fetchOne(uid, query) {
      assert.equal(uid, '42');
      assert.equal(query.bodyStructure, true);
      return {
        envelope: {
          subject: 'Factura PDF',
          from: [{ address: 'facturas@vitifrigo.test' }],
          date: new Date('2024-05-23T10:30:00.000Z'),
        },
        bodyStructure: {
          // multipart/mixed root with two children: text/plain and application/pdf
          childNodes: [
            { part: '1', type: 'text/plain', size: 120, disposition: 'inline' },
            {
              part: '2',
              type: 'application/pdf',
              size: 45000,
              disposition: 'attachment',
              dispositionParameters: { filename: 'factura-2024-005.pdf' },
            },
          ],
        },
      };
    },
  });
  const result = await intake.listAttachmentsInFolder({ folder: 'INBOX.Vitifrigo', uid: 42 });
  assert.equal(result.folder, 'INBOX.Vitifrigo');
  assert.equal(result.uid, 42);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].part, '2');
  assert.equal(result.attachments[0].type, 'application/pdf');
  assert.equal(result.attachments[0].filename, 'factura-2024-005.pdf');
  assert.equal(result.attachments[0].disposition, 'attachment');
  assert.equal(result.attachments[0].isPdf, true);
  assert.equal(result.attachments[0].size, 45000);
  assert.equal(result.hasBodyStructure, true);
});

test('listAttachmentsInFolder filters inline text parts without filenames', async () => {
  const intake = mockAttachmentClient({
    fetchOne() {
      return {
        envelope: { subject: 'No att', from: [{ address: 'a@b.test' }], date: new Date() },
        bodyStructure: {
          childNodes: [
            { part: '1', type: 'text/plain', size: 200, disposition: 'inline' },
          ],
        },
      };
    },
  });
  const result = await intake.listAttachmentsInFolder({ folder: 'INBOX', uid: 1 });
  assert.equal(result.attachments.length, 0);
});

test('listAttachmentsInFolder uses Content-Type name parameter as filename fallback', async () => {
  const intake = mockAttachmentClient({
    fetchOne() {
      return {
        envelope: { subject: 'Inline PDF', from: [{ address: 'a@b.test' }], date: new Date() },
        bodyStructure: {
          childNodes: [
            {
              part: '1',
              type: 'application/pdf',
              size: 30000,
              disposition: 'inline',
              parameters: { name: 'reporte.pdf' },
            },
          ],
        },
      };
    },
  });
  const result = await intake.listAttachmentsInFolder({ folder: 'INBOX', uid: 1 });
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].filename, 'reporte.pdf');
  assert.equal(result.attachments[0].isPdf, true);
});

test('listAttachmentsInFolder detects PDF by filename even with application/octet-stream', async () => {
  const intake = mockAttachmentClient({
    fetchOne() {
      return {
        envelope: { subject: 'Octet PDF', from: [{ address: 'a@b.test' }], date: new Date() },
        bodyStructure: {
          childNodes: [
            {
              part: '2',
              type: 'application/octet-stream',
              size: 25000,
              disposition: 'attachment',
              dispositionParameters: { filename: 'factura.pdf' },
            },
          ],
        },
      };
    },
  });
  const result = await intake.listAttachmentsInFolder({ folder: 'INBOX', uid: 1 });
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].isPdf, true);
});

test('listAttachmentsInFolder facade rejects invalid folder and uid', async () => {
  const tools = createMailTools({ state: {}, intake: { listAttachmentsInFolder: async () => ({}) } });
  await assert.rejects(tools.listAttachmentsInFolder({ folder: 'INBOX*', uid: 1 }), /forbidden/);
  await assert.rejects(tools.listAttachmentsInFolder({ folder: 'INBOX', uid: 0 }), /positive integer/);
});

test('listAttachmentsInFolder facade throws when intake is not configured', async () => {
  const tools = createMailTools({ state: {} });
  await assert.rejects(tools.listAttachmentsInFolder({ folder: 'INBOX', uid: 1 }), /IMAP intake is not configured/);
});

test('listAttachmentsInFolder requires a valid uid', async () => {
  const intake = mockAttachmentClient();
  await assert.rejects(intake.listAttachmentsInFolder({ folder: 'INBOX', uid: 0 }), /positive integer/);
  await assert.rejects(intake.listAttachmentsInFolder({ folder: 'INBOX', uid: -5 }), /positive integer/);
});

test('listAttachmentsInFolder rejects unselectable folders', async () => {
  const intake = mockAttachmentClient({
    list: () => [{ path: 'INBOX', name: 'Inbox' }],
  });
  await assert.rejects(intake.listAttachmentsInFolder({ folder: 'INBOX.Vitifrigo', uid: 1 }), /not selectable/);
});

// ── PDF attachment extraction ───────────────────────────────────────────────

test('fetchAttachmentPart fetches a body part and returns it as a Buffer', async () => {
  const pdfBytes = Buffer.from('%PDF-1.4 mock pdf data here');
  const intake = mockAttachmentClient({
    list: () => [{ path: 'INBOX.Vitifrigo', name: 'Vitifrigo' }],
    fetchOne(uid, query) {
      assert.equal(uid, '42');
      assert.equal(query.bodyStructure, true);
      assert.deepEqual(query.bodyParts, ['2']);
      return {
        bodyStructure: {
          childNodes: [
            { part: '1', type: 'text/plain', size: 100, disposition: 'inline' },
            {
              part: '2',
              type: 'application/pdf',
              size: pdfBytes.length,
              disposition: 'attachment',
              dispositionParameters: { filename: 'factura.pdf' },
            },
          ],
        },
        bodyParts: new Map([['2', pdfBytes]]),
      };
    },
  });
  const result = await intake.fetchAttachmentPart({ folder: 'INBOX.Vitifrigo', uid: 42, part: '2' });
  assert.equal(result.part, '2');
  assert.equal(result.type, 'application/pdf');
  assert.equal(result.filename, 'factura.pdf');
  assert.equal(result.size, pdfBytes.length);
  assert.ok(Buffer.isBuffer(result.data));
  assert.equal(result.data.toString(), '%PDF-1.4 mock pdf data here');
});

test('fetchAttachmentPart rejects invalid part numbers', async () => {
  const intake = mockAttachmentClient();
  await assert.rejects(intake.fetchAttachmentPart({ folder: 'INBOX', uid: 1, part: '' }), /valid MIME body part/);
  await assert.rejects(intake.fetchAttachmentPart({ folder: 'INBOX', uid: 1, part: 'abc' }), /valid MIME body part/);
  await assert.rejects(intake.fetchAttachmentPart({ folder: 'INBOX', uid: 1, part: '1.2a' }), /valid MIME body part/);
});

test('fetchAttachmentPart rejects nonexistent part in body structure', async () => {
  const intake = mockAttachmentClient({
    fetchOne() {
      return {
        bodyStructure: { childNodes: [{ part: '1', type: 'text/plain', size: 100, disposition: 'inline' }] },
        bodyParts: new Map(),
      };
    },
  });
  await assert.rejects(
    intake.fetchAttachmentPart({ folder: 'INBOX', uid: 1, part: '99' }),
    /body part "99" not found/,
  );
});

test('extractPdfInFolder facade requires confirm:true', async () => {
  const tools = createMailTools({
    state: {},
    intake: { fetchAttachmentPart: async () => ({ data: Buffer.from('%PDF-1.4 test') }) },
  });
  await assert.rejects(
    tools.extractPdfInFolder({ folder: 'INBOX.Vitifrigo', uid: 42, part: '2', confirm: false }),
    /confirm:true/,
  );
  await assert.rejects(
    tools.extractPdfInFolder({ folder: 'INBOX.Vitifrigo', uid: 42, part: '2' }),
    /confirm:true/,
  );
});

test('extractPdfInFolder facade rejects invalid inputs', async () => {
  const tools = createMailTools({
    state: {},
    intake: { fetchAttachmentPart: async () => ({ data: Buffer.from('%PDF-1.4 test') }) },
  });
  await assert.rejects(tools.extractPdfInFolder({ folder: 'INBOX*', uid: 1, part: '2', confirm: true }), /forbidden/);
  await assert.rejects(tools.extractPdfInFolder({ folder: 'INBOX', uid: 0, part: '2', confirm: true }), /positive integer/);
  await assert.rejects(tools.extractPdfInFolder({ folder: 'INBOX', uid: 1, part: '', confirm: true }), /valid MIME body part/);
});

test('extractPdfInFolder facade rejects non-PDF data without calling the extractor', async () => {
  let extractorCalled = false;
  const tools = createMailTools({
    state: {},
    intake: { fetchAttachmentPart: async () => ({ data: Buffer.from('Not a PDF at all') }) },
    pdfToolClient: {
      async extract() { extractorCalled = true; return { text: 'should not reach' }; },
    },
  });
  await assert.rejects(
    tools.extractPdfInFolder({ folder: 'INBOX.Vitifrigo', uid: 42, part: '2', confirm: true }),
    /valid PDF header/,
  );
  assert.equal(extractorCalled, false, 'PDF extractor must not be called for non-PDF data');
});

test('extractPdfInFolder forwards PDF bytes to the extractor and returns text plus a trust boundary', async () => {
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj');
  const pdfBase64 = pdfBytes.toString('base64');
  let extractPayload;

  const tools = createMailTools({
    state: {},
    intake: { fetchAttachmentPart: async () => ({ folder: 'INBOX.Vitifrigo', part: '2', type: 'application/pdf', filename: 'factura.pdf', size: pdfBytes.length, data: pdfBytes }) },
    pdfToolClient: {
      async extract(payload) {
        extractPayload = payload;
        return { text: 'Invoice #2024-005\nTotal: 1.234,56€', pages: 1 };
      },
    },
  });

  const result = await tools.extractPdfInFolder({
    folder: 'INBOX.Vitifrigo',
    uid: 42,
    part: '2',
    confirm: true,
  });

  assert.equal(extractPayload.data, pdfBase64);
  assert.equal(result.uid, 42);
  assert.equal(result.part, '2');
  assert.equal(result.filename, 'factura.pdf');
  assert.equal(result.type, 'application/pdf');
  assert.ok(result.size > 0);
  assert.equal(result.pages, 1);
  assert.match(result.text, /Invoice/);
  assert.equal(result.textTruncated, false);
  assert.ok(result.trustBoundary.includes('untrusted data'));
});

test('extractPdfInFolder caps maxChars and maxPages to the hard ceiling', async () => {
  const tools = createMailTools({
    state: {},
    intake: { fetchAttachmentPart: async () => ({ data: Buffer.from('%PDF-1.4 content') }) },
    pdfToolClient: {
      async extract(payload) {
        assert.equal(payload.maxChars, 10_000, 'maxChars must be capped to MAX_PDF_TEXT_CHARS');
        assert.equal(payload.maxPages, 20, 'maxPages must be capped to MAX_PDF_PAGES');
        return { text: 'Extracted' };
      },
    },
  });
  const result = await tools.extractPdfInFolder({
    folder: 'INBOX.Vitifrigo',
    uid: 42,
    part: '2',
    confirm: true,
    maxChars: 99999,
    maxPages: 999,
  });
  assert.match(result.text, /Extracted/);
  assert.equal(result.textTruncated, false);
});

test('extractPdfInFolder surfaces structured invoiceFields while keeping PII redaction on free text', async () => {
  const tools = createMailTools({
    state: {},
    intake: { fetchAttachmentPart: async () => ({ data: Buffer.from('%PDF-1.4 invoice') }) },
    pdfToolClient: {
      async extract() {
        return {
          text: 'Contacto: cobros@vitifrigo.test / +34 928 123 456',
          pages: 1,
          invoiceFields: {
            invoiceNumber: '2024-005',
            totals: { subtotal: null, tax: null, total: 1234.56 },
          },
        };
      },
    },
  });
  const result = await tools.extractPdfInFolder({
    folder: 'INBOX.Vitifrigo',
    uid: 42,
    part: '2',
    confirm: true,
  });
  assert.match(result.text, /\[redacted-email\]/);
  assert.match(result.text, /\[redacted-phone\]/);
  assert.deepEqual(result.invoiceFields, {
    invoiceNumber: '2024-005',
    totals: { subtotal: null, tax: null, total: 1234.56 },
  });
});

test('extractPdfInFolder facade throws when intake is not configured', async () => {
  const tools = createMailTools({ state: {} });
  await assert.rejects(
    tools.extractPdfInFolder({ folder: 'INBOX', uid: 1, part: '2', confirm: true }),
    /IMAP intake is not configured/,
  );
});

test('extractPdfInFolder the IMAP source must not reference message source or fixed literal sizes for attachment parts', async () => {
  const source = await readFile(new URL('../src/imap-client.js', import.meta.url), 'utf8');
  // fetchAttachmentPart must use bodyParts, not source
  const section = source.match(/async fetchAttachmentPart\([\s\B]*?\n  \}/);
  if (section) {
    assert.equal(/\bsource\s*:/.test(section[0]), false, 'fetchAttachmentPart must not use source:');
  }
  // listAttachmentsInFolder must use bodyStructure
  const listSection = source.match(/async listAttachmentsInFolder\([\s\B]*?\n  \}/);
  if (listSection) {
    assert.equal(/\bbodyStructure\s*:/.test(listSection[0]), true, 'listAttachmentsInFolder must use bodyStructure:');
  }
});
