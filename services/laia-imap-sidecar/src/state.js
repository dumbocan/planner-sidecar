import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STATE_DIR = '/var/lib/laia-imap';

export class ImapState {
  constructor(stateDir = process.env.IMAP_STATE_DIR ?? STATE_DIR) {
    if (path.resolve(stateDir) !== STATE_DIR) throw new Error('IMAP_STATE_DIR must use the sidecar-only state mount');
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(STATE_DIR, 'imap-state.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS mailbox_cursors (
        mailbox TEXT PRIMARY KEY,
        uidvalidity INTEGER NOT NULL,
        last_uid INTEGER NOT NULL
      );
       CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        mailbox TEXT NOT NULL,
        uidvalidity INTEGER NOT NULL,
        uid INTEGER NOT NULL,
        thread_key TEXT,
        date TEXT,
        sender TEXT,
        subject TEXT,
        sanitized_excerpt TEXT NOT NULL,
         UNIQUE (mailbox, uidvalidity, uid)
       );
       CREATE TABLE IF NOT EXISTS intake_anomalies (
         id INTEGER PRIMARY KEY,
         mailbox TEXT NOT NULL,
         uidvalidity INTEGER NOT NULL,
         uid INTEGER NOT NULL,
         kind TEXT NOT NULL CHECK(kind IN ('message_id_invalid', 'message_id_mismatch')),
         recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         UNIQUE (mailbox, uidvalidity, uid, kind)
       );
    `);
  }

  getCursor(mailbox) {
    return this.db.prepare('SELECT uidvalidity, last_uid AS lastUid FROM mailbox_cursors WHERE mailbox = ?').get(mailbox) ?? null;
  }

  setCursor(mailbox, uidvalidity, lastUid) {
    this.db.prepare(`INSERT INTO mailbox_cursors (mailbox, uidvalidity, last_uid) VALUES (?, ?, ?)
      ON CONFLICT(mailbox) DO UPDATE SET uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid`).run(mailbox, uidvalidity, lastUid);
  }

  claimMessage(message) {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO messages
      (message_id, mailbox, uidvalidity, uid, thread_key, date, sender, subject, sanitized_excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(message.messageId, message.mailbox, message.uidvalidity, message.uid, message.threadKey ?? null,
        message.date ?? null, message.from ?? null, message.subject ?? null, message.sanitizedExcerpt ?? '');
    return inserted.changes === 1;
  }

  hasMessageId(messageId) {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE message_id = ?').get(messageId));
  }

  recordAnomaly({ mailbox, uidvalidity, uid, kind }) {
    if (!['message_id_invalid', 'message_id_mismatch'].includes(kind)) throw new Error('IMAP anomaly kind is invalid');
    this.db.prepare(`INSERT OR IGNORE INTO intake_anomalies (mailbox, uidvalidity, uid, kind)
      VALUES (?, ?, ?, ?)`).run(mailbox, uidvalidity, uid, kind);
    this.db.prepare(`DELETE FROM intake_anomalies WHERE id NOT IN (
      SELECT id FROM intake_anomalies ORDER BY id DESC LIMIT 500
    )`).run();
  }

  listDigestCandidates(limit) {
    return this.db.prepare(`SELECT message_id AS messageId, mailbox, date, sender AS "from", subject
      FROM messages ORDER BY date DESC, uid DESC LIMIT ?`).all(limit);
  }

  getMessage(messageId) {
    return this.db.prepare(`SELECT message_id AS messageId, mailbox, date, sender AS "from", subject,
      sanitized_excerpt AS sanitizedExcerpt FROM messages WHERE message_id = ?`).get(messageId) ?? null;
  }

  getThreadMetadata(messageId, limit) {
    const target = this.db.prepare('SELECT thread_key AS threadKey FROM messages WHERE message_id = ?').get(messageId);
    if (!target?.threadKey) return [];
    return this.db.prepare(`SELECT message_id AS messageId, mailbox, date, sender AS "from", subject
      FROM messages WHERE thread_key = ? ORDER BY date ASC, uid ASC LIMIT ?`).all(target.threadKey, limit);
  }
}
