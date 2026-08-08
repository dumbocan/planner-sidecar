# Laia IMAP Read-Only Sidecar

Local, hostinger-side IMAP intake that exposes five MCP tools to OpenClaw.
No SMTP, no send/reply/move/delete/flag, no shell, no generic HTTP, no
Engram mount. The sidecar exists so the agent can answer bounded email
questions without widening the existing per-mailbox digest.

## Quick Path

1. Provision `imap-secrets/username` and `imap-secrets/password` (mode `600`).
2. `docker compose build laia-imap-sidecar` (no IMAP traffic).
3. `docker compose up -d laia-imap-sidecar`.
4. `docker compose exec laia-imap-sidecar node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1))"`.

## Purpose and Security Boundary

| Allowed | Forbidden |
|---------|-----------|
| Read-only IMAP over TLS to `imap.hostinger.com:993` (`rejectUnauthorized`, `minVersion: 'TLSv1.2'`) | SMTP, send, reply, move, delete, flag, expunge |
| Bounded `BODY.PEEK` for the Inbox/Sent intake | Raw MIME, body fetch, attachments |
| Sanitized excerpts persisted to the local SQLite volume | Remote mailbox persistence; one-shot search persistence |
| Redacted headers by default; raw only with explicit `redact: false` | Logging bodies, message bodies, header raw values, mailbox paths, error messages |

`server.js` swallows every tool failure behind the generic envelope
`IMAP read-only intake is unavailable.` and logs only `{event: 'imap_tool_failure', tool, error}` to stderr (`error` is the constructor name). It never logs error messages, mailbox paths, or mail data.

Credentials live only at `/run/secrets/imap-read-only/{username,password}` (mode `600`, mounted read-only). Do not put credentials in `.env`, Compose, state, workspace, Gateway, CLI, or Engram.

## Runtime Architecture

| Surface | Value |
|---------|-------|
| Compose service | `laia-imap-sidecar` (image `laia-imap-sidecar:local`) |
| Build context | `./services/laia-imap-sidecar` |
| User | `1000:1000`, `read_only`, `cap_drop: ALL`, `no-new-privileges` |
| Networks | `imap-mcp-internal` (`internal: true`) + `imap-egress` |
| Public port | None. No `ports:` mapping; reachable only from `imap-mcp-internal` via `http://laia-imap-sidecar:3000/mcp` |
| Health | `GET /healthz` → `200 ok` (also used by the Compose healthcheck) |
| Mounts | `./imap-secrets:/run/secrets/imap-read-only:ro`, `./imap-state:/var/lib/laia-imap` |
| Env | `IMAP_BOOTSTRAP_DAYS` (default `30`, integer `1..365`) |
| MCP transport | Streamable HTTP on `POST/GET/DELETE /mcp` |

`imap-state/` is the only place IMAP cursors, anomaly records, and sanitized excerpts are persisted, and `.gitignore` excludes everything except `.gitkeep`.

## Tool Inventory and Redaction

| Tool | Default output | Privacy rule |
|------|----------------|--------------|
| `mail_list_digest_candidates` | Sanitized envelope for the bootstrap window + new UIDs of Inbox/Sent | sender/subject redacted to `[redacted-email]`/`[redacted-url]`/`[redacted-phone]` |
| `mail_get_sanitized_excerpt` | One excerpt, `defaultChars=1200`, max `2000` | raw MIME never returned |
| `mail_get_thread_metadata` | Thread metadata (no body), `defaultLimit=10`, max `20` | raw mail never returned |
| `mail_list_mailboxes` | `{path, name}` strings only, capped at `200` | excludes `\Noselect`/`\NonExistent`; no counts, no status |
| `mail_search_in_mailbox` | Envelope-only fetch for one selectable folder | date-only IMAP search; redacted by default; max `20` results |

Redaction is the default. The agent must not pass `redact: false` unless the caller explicitly asked for raw sender/subject.

## Data Behavior and Folder Coverage

Two distinct intake paths share the same transport.

### Inbox + Sent digest intake (background sync)

- `selectSyncMailboxes` keeps only `INBOX` and the IMAP `\\Sent` special-use mailbox, falling back to a bounded standard-name allowlist (`sent`, `sent items`, `sent mail`, `enviados`, `enviado`, `gesendet`, `inviati`, `posta inviata`, `outbox`).
- Bootstrap seeds the cursor to the captured `UIDNEXT - 1` and only accepts messages whose IMAP `internalDate` is at or after the cutoff. `IMAP_BOOTSTRAP_DAYS` defaults to `30` (range `1..365`). The IMAP `SINCE` window starts one UTC calendar day earlier because `SINCE` is date-granular.
- After bootstrap, polls query only `startUid:*` and never rescan history.
- Message-ID canonicalization folds angle brackets, whitespace, and casing into one bounded key; missing/duplicate/mismatched RFC822 `Message-ID` headers advance the cursor and emit a bounded anomaly record (`mailbox`, `uidvalidity`, `uid`, `kind`) — never raw identifiers, headers, bodies, or credentials.

### One-shot arbitrary-folder search (live read)

- `mail_list_mailboxes` reopens a fresh IMAP `LIST`, filters selectable mailboxes, and never returns counts, status, or message content.
- `mail_search_in_mailbox` re-opens the fresh list to validate the mailbox path, opens a read-only `getMailboxLock`, runs an envelope-only IMAP `SINCE`/`BEFORE` search (date strings, never `TEXT`/`BODY`), fetches only `{envelope, internalDate}`, applies `senderFilter`/`subjectFilter` after the fetch, caps at `20` results, and always releases the lock in `finally`.
- Limits: `mailbox` ≤ 256 chars, no wildcards/control bytes; `fromDate`/`toDate` strictly `YYYY-MM-DD`; range ≤ 366 days; `senderFilter`/`subjectFilter` ≤ 256 chars, no control bytes; `limit` 1..20, default 20.
- **It is a one-shot bounded search, never a background full-folder ingestion, and never replaces Inbox/Sent.**

### Hostinger folder names

- The spam folder is the selectable path `INBOX.Junk`. Do not assume a literal `Unwanted` / `No Deseado` folder.
- Hostinger uses flat `INBOX.<Folder>` naming (e.g. `INBOX.Sent`, `INBOX.Drafts`, `INBOX.Junk`, `INBOX.Trash`).
- Always call `mail_list_mailboxes` first; use the returned `path` value verbatim in `mail_search_in_mailbox`. Do not pass wildcards, ambiguous names, or values not present in the fresh list.

## Local Development

Tests run without Docker and do not touch IMAP. Dependencies are already installed in this checkout.

```bash
cd services/laia-imap-sidecar
node --test test/**/*.test.js
```

Rebuild and recreate ONLY this sidecar (does not touch Gateway, the Google sidecar, or any other service):

```bash
docker compose build laia-imap-sidecar
docker compose up -d laia-imap-sidecar
```

To force a fresh container without stopping neighbors:

```bash
docker compose up -d --force-recreate laia-imap-sidecar
```

Set the bootstrap window before recreating (non-secret deployment var, no `.env`):

```bash
IMAP_BOOTSTRAP_DAYS=30 docker compose up -d --force-recreate laia-imap-sidecar
```

The sidecar never starts a poll from `/healthz`; health checks are shallow liveness only.

## Troubleshooting

| Symptom | Likely cause | What to check |
|---------|--------------|---------------|
| Healthcheck fails on `/healthz` | Container not listening on `3000`, or wrong network | `docker compose ps laia-imap-sidecar`, `docker compose logs laia-imap-sidecar` |
| Every tool returns the generic `IMAP read-only intake is unavailable.` | Credentials missing/empty, or the server is unreachable from `imap-egress` | `imap-secrets/username` and `imap-secrets/password` (mode `600`), outbound TLS to `imap.hostinger.com:993` |
| `mail_search_in_mailbox` rejects a known folder | Folder not in the fresh `LIST`, has `\Noselect`/`\NonExistent`, or contains wildcards | Re-run `mail_list_mailboxes`, copy `path` verbatim, no `*`/`%` |
| `fromDate`/`toDate` invalid | Wrong shape, inverted, or > 366-day window | Strict `YYYY-MM-DD`, from ≤ to, range ≤ 366 days |
| Bootstrap captures the wrong window | `IMAP_BOOTSTRAP_DAYS` set outside `1..365` or non-integer | Recreate with `IMAP_BOOTSTRAP_DAYS=30` |

Health is reported only from `imap-state/` and `/healthz`; do not infer state from `docker compose ps` alone.

## Non-Goals / Do-Not

- **Do not** add SMTP, send, reply, move, delete, flag, expunge, copy, append, set, or status tools.
- **Do not** fetch raw MIME, body parts, or attachments through `mail_get_sanitized_excerpt`, `mail_get_thread_metadata`, or `mail_search_in_mailbox`.
- **Do not** persist remote mailbox content outside the bounded `imap-state/` SQLite volume, and do not bypass Message-ID canonicalization.
- **Do not** log message bodies, message IDs (raw or canonical), sender/subject values, mailbox paths, error messages, or credentials.
- **Do not** put credentials in `.env`, Compose, state, workspace, Gateway, CLI, or Engram. Provision them only via `imap-secrets/`.
- **Do not** edit `docker-compose.yml`, the gateway, the Google sidecar, OpenClaw state/config, workspace instructions, or restart anything to "fix" this sidecar.
- **Do not** call `mail_search_in_mailbox` with wildcards, ambiguous names, or values not in a fresh `mail_list_mailboxes` result.
- **Do not** treat `mail_search_in_mailbox` as a background full-folder ingestion or use it to replace the Inbox/Sent intake.

## VPS Migration Reminder

`imap-secrets/` and `imap-state/` must be provisioned separately from the
host checkout: secrets through the deployment pipeline (never Git), state
through a persistent volume or managed snapshot outside the repository.
Both paths are blocked by `.gitignore`. The VPS cutover plan in
`docs/internal/vps-migration.md` keeps the host and the future host's
OpenCode/Gateway Engram stores as separate snapshots and does not move
either in this change set.

## Sources

- ImapFlow mailbox locks and `readOnly`: https://github.com/postalsys/imapflow/blob/master/_autodocs/imapflow-client-api.md
- ImapFlow mailbox special-use listing: https://github.com/postalsys/imapflow/blob/master/_autodocs/imapflow-client-api.md
- ImapFlow `BODY.PEEK` source behavior: https://github.com/postalsys/imapflow/blob/master/lib/commands/fetch.js
- ImapFlow `SINCE` date searches: https://github.com/postalsys/imapflow/blob/master/_autodocs/search-queries.md
