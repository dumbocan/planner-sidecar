# Google Read-Only Sidecar

Local Google intake that exposes eleven MCP tools to OpenClaw. Two Google
accounts (`laia`, `personal`) with `gmail.readonly` + `calendar.freebusy`
plus per-slot calendar event scopes (`calendar.events` for `laia`,
`calendar.events.readonly` for `personal`) and per-slot contact scopes
(`contacts` + `contacts.other.readonly` for `laia`,
`contacts.readonly` for `personal`). No send, modify, delete, shell,
generic HTTP, filesystem, or Engram mount. Calendar event write and
contact write are permitted only on the `laia` account.

## Quick Path

1. Enable Gmail API, Google Calendar API, and People API in Google Cloud for the dedicated account.
2. Save the Desktop OAuth JSON as `google-secrets/desktop-client.json` for slot `laia` and `google-secrets/gmail-dumbo-cata-desktop-client.json` for slot `personal` (mode `600`).
3. `docker compose build google-read-sidecar`.
4. Run the one-time PKCE loopback authorization for each slot:
   - `laia`: `docker run --rm --network host --user 1000:1000 -v "$PWD/google-secrets:/run/secrets/google-read-only" openclaw-google-read-sidecar:local node scripts/authorize.js laia`
   - `personal`: `docker run --rm --network host --user 1000:1000 -v "$PWD/google-secrets:/run/secrets/google-read-only" openclaw-google-read-sidecar:local node scripts/authorize.js personal`
5. Approve the scopes printed by the script (Gmail read + Calendar freebusy + per-slot calendar events + per-slot contacts). The command writes the matching `token.json` (mode `600`).
6. `docker compose up -d google-read-sidecar`.

## Purpose and Security Boundary

| Allowed | Forbidden |
|---------|-----------|
| `gmail.readonly`, `calendar.freebusy`, plus per-slot event scopes (`calendar.events` for `laia`, `calendar.events.readonly` for `personal`) and per-slot contact scopes (`contacts` + `contacts.other.readonly` for `laia`, `contacts.readonly` for `personal`) | Gmail send/modify/delete, Calendar ACL writes, watch channels, contact write scopes other than `contacts`, service-account JSON |
| Metadata-only and bounded sanitized Gmail excerpts | Raw MIME, attachments, full message bodies |
| Free/busy windows for both slots | Calendar event write/delete from slot `personal`; Google's per-token scope is the real fail-closed boundary |
| Calendar event list/create/update/delete for slot `laia` | Calendar event write/delete from slot `personal` (defense-in-depth runtime guard, API rejects at token layer) |
| Contact search/get for both slots; contact create/update for slot `laia` | Contact create/update from slot `personal` (defense-in-depth runtime guard, API rejects at token layer) |
| Two-account keyring (`laia`, `personal`), loaded from secrets dir | Extra accounts, refresh tokens in Engram/workspace/logs |
| Failures collapse to the generic envelope `Google read-only integration is unavailable.` | Logging API error bodies, message bodies, message IDs, refresh tokens, or client secrets |

Scope validation is two-sided: `validateGrantedScopes` throws if any
granted scope is outside `ALLOWED_SCOPES` (forbidden check) or if a
required scope is missing (required check). `REQUIRED_SCOPES` are the
two scopes every account must hold (`gmail.readonly` +
`calendar.freebusy`); `ALLOWED_SCOPES` is the union of acceptable
scopes. `initSingleAccount` re-validates scopes on every token refresh;
an account whose refreshed scopes drift fails closed. The contact
scope ladder is intentionally narrow: `contacts` is write+read of own
contacts for `laia` only; `contacts.other.readonly` reads contacts
shared with `laia`; `contacts.readonly` is the only contact scope
granted to `personal`. The write-shared scope `contacts.other` is
forbidden by `validateGrantedScopes`.

## Runtime Architecture

| Surface | Value |
|---------|-------|
| Compose service | `google-read-sidecar` (image `openclaw-google-read-sidecar:local`) |
| Build context | `./services/google-read-sidecar` |
| User | `1000:1000`, `read_only`, `cap_drop: ALL`, `no-new-privileges` |
| Networks | `google-mcp-internal` (`internal: true`) + `google-egress` |
| Public port | None. No `ports:` mapping; reachable only from `google-mcp-internal` via `http://google-read-sidecar:3000/mcp` |
| Health | `GET /healthz` → `200 ok` (also used by the Compose healthcheck) |
| Mounts | `./google-secrets:/run/secrets/google-read-only:ro` |
| Env | `PORT` (default `3000`), `GOOGLE_SECRET_DIR` (must equal the sidecar-only mount) |
| MCP transport | Streamable HTTP on `POST/GET/DELETE /mcp` |

`google-secrets/` files (`desktop-client.json`, `token.json`, `gmail-dumbo-cata-*.json`) are listed by `.gitignore`; only `google-secrets/README.md` is tracked.

## Tool Inventory and Redaction

| Tool | Input | Output | Privacy rule |
|------|-------|--------|--------------|
| `gmail_search` | `query` (1..500), `maxResults` (default 10, max 20), `account` | `{id, threadId, from, subject, date, snippet}` × ≤ `maxResults` | `from`/`subject` truncated to 256 chars, URL/email/phone redacted, `snippet` ≤ 400 chars |
| `gmail_get_sanitized` | `messageId` (`/^[A-Za-z0-9_-]{1,128}$/`), `maxChars` (default 1200, max 2000), `account` | `{id, threadId, from, subject, date, excerpt}` | Only the `text/plain` part is decoded; URL/email/phone redacted; truncated to `maxChars` |
| `calendar_freebusy` | `timeMin`/`timeMax` (RFC3339), `calendarIds` (1..5), `timeZone?`, `account` | `{timeMin, timeMax, calendars[busy, errors]}` | `timeMax - timeMin` must be ≤ 31 days; `timeMax > timeMin` |
| `calendar_list_events` | `calendarId`, `timeMin`, `timeMax` (RFC3339, ≤ 366 days), `maxResults` (default 25, max 100), `query?`, `singleEvents?`, `showDeleted?`, `account` | `{calendarId, count, events[]}` | Returns summary, description, location, attendees, start/end. Bounded to 100 events per call. `summary`/`location`/`attendees[*].email` redacted to 256 chars; `description` to 2000 chars. URLs → `[redacted-url]`, emails → `[redacted-email]`, phones → `[redacted-phone]`. |
| `calendar_create_event` | `calendarId`, `summary` (1..1024), `description?`, `start`, `end`, `timeZone?`, `attendees?`, `account` | normalized event | `account` must be `laia`; runtime guard rejects `personal` even if the Zod schema is bypassed. Google's per-token scope is the real fail-closed boundary. Returned event is redacted the same way as `calendar_list_events`. |
| `calendar_update_event` | `calendarId`, `eventId`, plus any of `summary?`, `description?`, `start?`, `end?`, `timeZone?`, `attendees?`, `account` | normalized event | `account` must be `laia`. Defense-in-depth runtime guard; API rejects at token layer. Returned event is redacted. |
| `calendar_delete_event` | `calendarId`, `eventId`, `account` | `{deleted: true, calendarId, eventId}` | `account` must be `laia`. Defense-in-depth runtime guard; API rejects at token layer. No event payload, nothing to redact. |
| `contacts_search` | `query` (1..500), `maxResults` (default 25, max 100), `readMask?`, `account` | `{query, count, contacts[]}` | Returns sanitized name fields, emails, phones, organization. Both accounts; `personal` returns whatever the shared label exposes. `displayName` 256, `givenName`/`familyName` 128, `emailAddresses[*].value` 256, `phoneNumbers[*].value` 32, `organization` 256, `urls[*].value` 256. URLs, emails, phones → redaction placeholders. |
| `contacts_get` | `resourceName` (`people/...`, 1..1024), `personFields?`, `account` | normalized contact | One contact by resourceName. Both accounts. Same redaction rules as `contacts_search`. |
| `contacts_create` | `givenName?`, `familyName?`, `displayName?`, `emailAddresses?`, `phoneNumbers?`, `organization?`, `account` | normalized contact | `account` must be `laia`; runtime guard rejects `personal`. At least one mutable field required. `emailAddresses`/`phoneNumbers` accept strings or `{ value }` objects, capped at 20 each. Returned contact is redacted. |
| `contacts_update` | `resourceName` (`people/...`), `etag`, plus any of `givenName?`, `familyName?`, `displayName?`, `emailAddresses?`, `phoneNumbers?`, `organization?`, `account` | normalized contact | `account` must be `laia`; defense-in-depth runtime guard, API rejects at token layer. `etag` is required for safety. Only the fields you supply are sent; `updatePersonFields` is derived from the non-undefined inputs. Returned contact is redacted. |

`account` is `laia` (default, `laijmelectronautica@gmail.com`) or `personal` (`dumbo.cata@gmail.com`). Account files: `desktop-client.json` + `token.json` for `laia`; `gmail-dumbo-cata-desktop-client.json` + `gmail-dumbo-cata-token.json` for `personal`. The write tools accept `account` only as `laia`; the runtime guard rejects other values with `write operations require the laia account`.

## Data Behavior and Account Coverage

- All eleven tools are live reads or writes against Google APIs; no Gmail, Calendar, or Contacts content is persisted locally and the sidecar has no Engram mount.
- The `laia` account failure is fatal on startup (`createGoogleClients` throws) so a half-broken keyring cannot silently fall back. `personal` failures are logged but tolerated; missing `personal` files do not block `laia` traffic.
- `personal` is re-authorized with `calendar.events.readonly` so `calendar_list_events` returns rich event info for Javier's personal calendar. Event write/delete from `personal` is rejected at the runtime layer (defense-in-depth) and at the Google API layer (token lacks `calendar.events`).
- `personal` is re-authorized with `contacts.readonly` so `contacts_search`/`contacts_get` return whatever the share label exposes. Contact write from `personal` is rejected at the runtime layer (defense-in-depth) and at the Google API layer (token lacks `contacts`). Sharing the "Mis contactos" label from `dumbo.cata@gmail.com` to `laijmelectronautica@gmail.com` is configured in the Google Contacts UI; this sidecar does not configure the share.
- Free/busy uses `calendarExpansionMax = 5`, `groupExpansionMax = 0`, so cross-calendar free-busy lookups are bounded.
- Token refresh happens lazily on the first tool call after expiry; an out-of-scope refresh fails closed per `validateGrantedScopes`.

## Local Development

Tests run without Docker and do not touch Google APIs. Dependencies are already installed in this checkout.

```bash
cd services/google-read-sidecar
node --test test/**/*.test.js
```

Rebuild and recreate ONLY this sidecar (does not touch Gateway, the IMAP sidecar, or any other service):

```bash
docker compose build google-read-sidecar
docker compose up -d google-read-sidecar
```

To force a fresh container without stopping neighbors:

```bash
docker compose up -d --force-recreate google-read-sidecar
```

Loopback authorization needs a browser that can reach the host's loopback
listener. On a remote Docker host, use an SSH browser tunnel before
running `scripts/authorize.js`; do not paste codes into chat, logs, or
Engram, and do not use the deprecated out-of-band copy/paste flow.

## Troubleshooting

| Symptom | Likely cause | What to check |
|---------|--------------|---------------|
| Healthcheck fails on `/healthz` | Container not listening on `3000`, or wrong network | `docker compose ps google-read-sidecar`, `docker compose logs google-read-sidecar` |
| Every tool returns `Google read-only integration is unavailable.` | Account files missing/invalid, or scope drift on refresh | `google-secrets/` contents (mode `600`), token JSON shape, `validateGrantedScopes` failures |
| `account "personal" is not available` | Optional account present but not initialized | Ok; `personal` is optional. `laia` is required. |
| `forbidden scope granted: …` | OAuth flow approved a forbidden scope | Re-authorize with only the scopes printed by `scripts/authorize.js` |
| `write operations require the laia account` | `account` is `personal` (or anything other than `laia`) for a write tool | Switch `account` to `laia`. The runtime guard is defense-in-depth; Google's per-token scope is the real boundary. |
| `required scope missing: …` | Token does not include `gmail.readonly` or `calendar.freebusy` | Re-authorize the slot. The two scopes are required for every account. |
| Free/busy rejects `timeMax - timeMin` | Window > 31 days | Tighten the window; `calendar_freebusy` is bounded to 31 days, not arbitrary history |
| `event interval must not exceed 366 days` | `calendar_list_events` window > 366 days | Tighten the window |
| `messageId must be a Gmail message identifier` | Wrong shape on `gmail_get_sanitized` | Gmail message IDs are `[A-Za-z0-9_-]{1,128}`; use the value from `gmail_search` |

## Non-Goals / Do-Not

- **Do not** add Gmail send/modify/delete/labels/drafts, Calendar ACL/watch, contact directory scopes, or arbitrary Google API tools. Calendar event write and contact write are permitted only on the `laia` slot — never widen to `personal`.
- **Do not** accept a third account, a service-account JSON key, a refresh token from Engram, or any path other than `/run/secrets/google-read-only`.
- **Do not** widen `ALLOWED_SCOPES` to include `gmail.send`, `gmail.modify`, `gmail.compose`, `gmail.labels`, `calendar.acl`, `calendar.settings`, or `contacts.other` (write-shared contacts); do not relax `validateGrantedScopes`. `REQUIRED_SCOPES` must stay required and forbidden scopes must stay forbidden.
- **Do not** log token JSON, refresh tokens, client secrets, message bodies, message IDs, or full API error bodies. Log only the generic envelope.
- **Do not** persist Gmail content, return raw MIME, decode parts other than `text/plain`, or pass through attachments.
- **Do not** put credentials in `.env`, Compose, state, workspace, Gateway, CLI, or Engram. Provision only via `google-secrets/`.
- **Do not** edit `docker-compose.yml`, the gateway, the IMAP sidecar, OpenClaw state/config, workspace instructions, or restart anything to "fix" this sidecar.

## VPS Migration Reminder

`google-secrets/` must be provisioned separately from the host checkout:
OAuth client JSON through the deployment pipeline, refresh tokens only
through the documented one-time PKCE loopback command. The directory is
blocked by `.gitignore` except for `google-secrets/README.md`. The VPS
cutover plan in `docs/internal/vps-migration.md` keeps the host and the
future host's OpenCode/Gateway Engram stores as separate snapshots and
does not move either in this change set.

## Sources

- OpenClaw Streamable HTTP MCP: https://docs.openclaw.ai/cli/mcp
- Google OAuth desktop PKCE and loopback: https://developers.google.com/identity/protocols/oauth2/native-app
- Gmail search: https://developers.google.com/workspace/gmail/api/guides/filtering
- Calendar Freebusy: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Calendar Events list/insert/patch/delete: https://developers.google.com/workspace/calendar/api/v3/reference/events
- People API searchContacts/get/createContact/updateContact: https://developers.google.com/people/api/rest/v1/people/searchContacts
- People API directory readContactsOther: https://developers.google.com/people/api/rest/v1/otherContacts/list
