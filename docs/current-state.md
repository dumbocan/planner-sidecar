# Current State

## 2026-08-03 - Audio transcription FIXED: local faster-whisper in gateway container

- **Problem**: Voice notes in Telegram arrived as audio but produced no transcript. Laia's diagnosis (whisper-cli not installed, no internet, no pip) was WRONG — the gateway container has internet; the real issue was `tools.media.audio` pointing at `provider: "openai"` with `gpt-4o-transcribe` but NO OpenAI credential anywhere (doctor: `openai-whisper-api is allowed but unavailable: env: OPENAI_API_KEY`).
- **Fix (option B — local, no API cost)**: Installed faster-whisper INSIDE the gateway container (its own system):
  - `python3-pip` + venv at `/home/node/.openclaw/local-tools/whisper-venv`
  - `faster-whisper 1.2.1` (PyAV/FFmpeg bundled — no system ffmpeg needed)
  - Model `small` (464MB) cached at `/home/node/.openclaw/local-tools/hf-cache` (persistent, survives container recreate)
  - Wrapper `services/transcribe.py` (copied to `state/local-tools/transcribe.py`) — prints plain transcript to stdout (OpenClaw CLI contract)
  - `tools.media.audio.models` now: `{ type: "cli", command: ".../whisper-venv/bin/python", args: [".../transcribe.py", "{{MediaPath}}"], timeoutSeconds: 120 }`
- **Persistence**: everything lives under `state/local-tools/` (bind-mounted rw from host) so `--force-recreate` of the gateway does NOT lose the venv or the 464MB model.
- **Verified**: wrapper runs exit 0 and transcribes (tone test → "You"). Gateway restarted (restart, not recreate — venv survives). No audio/media errors in gateway logs. Javier confirmed via Telegram: transcription works.
- **Gotchas**: Debian 12 PEP 668 → must use venv, NOT `--break-system-packages`. HF cache structure is `HF_HOME/hub/models--<org>--<model>` (not `HF_HOME/models--...`). Exec as root in container via `docker exec -u root` (no sudo inside). `state/local-tools` is runtime, NOT versioned (only `services/transcribe.py` + docs are committed).

## 2026-08-03 - Google-read calendar fixed: BOTH tokens were revoked (laia + personal)

- **Root cause of the "Google Calendar unavailable" nights (31/7, 1/8, 2/8)**: BOTH OAuth refresh tokens were revoked by Google (`invalid_grant: Token has been expired or revoked`). The 2/8 00:01 "fix" Laia reported only fixed the cron prompt (RFC3339 Atlantic/Canary, no `orderBy`, one retry) — the real MCP failure for `account=laia` remained until token re-auth.
- **Fix**: Re-authenticated via PKCE loopback both slots: `token.json` (laia, 4/8 00:05) and `gmail-dumbo-cata-token.json` (personal, 4/8 00:17). Recreated the sidecar with `--force-recreate` (a plain `up -d` does NOT reload cached tokens — the OAuth client keeps the old refresh token in memory in `clientsPromise`).
- **Verified**: MCP direct via `/mcp` (port 3000): laia returns real events, personal returns OK-empty. Cron `14babf87` ran clean twice: ok, delivered, 0 consecutive errors. Next run 2026-08-03 21:00 Atlantic/Canary. Gateway did NOT need restart (sidecar kept IP 172.19.0.2; Streamable HTTP re-initializes).
- **Diagnosis gotchas**: MCP tool errors are swallowed by server.js's generic "Google read-only integration is unavailable."; `docker logs` empty (log file not readable). To diagnose: exec node directly in the container and test the refresh token via googleapis, or POST initialize + tools/call to /mcp (no curl/wget in the container).
- **User note**: the nightly summary showed only laia's agenda because personal was failing; both are now healthy. Whether the summary should prioritize `personal` (dumbo.cata) vs `laia` depends on where Javier's events live (they currently appear in laia's calendar).

## 2026-07-29 - Session close: Mail security audit + tool count corrections

- **Mail sidecar security audit complete** — 4 findings: (1) `authorize.js` personal slot requests `contacts` instead of `contacts.readonly`, (2) Telegram direct allows web_fetch/search/browser (prompt injection surface), (3) `openclaw.json` plaintext tokens (OpenClaw's own config, skip), (4) `outlook_list_attachments` registered in code but not in allowlist.
- **Tool count corrections verified against source:**
  - Laia IMAP sidecar: **8 tools** (not 7) — `mail_get_thread_metadata` was omitted
  - Google Read sidecar: **11 tools** ✅
  - Outlook Mail sidecar: **7 tools** ✅
  - Planner sidecar: **13 tools** (not 7) — Phase 2 added `planner_update_task`, `planner_delete_task`, `planner_create_plan`, `planner_create_bucket`, `planner_update_bucket`, `planner_delete_bucket`
- **PDF Extractor sidecar**: Text-only with `pdfjs-dist`, never JPG/OCR.
- **Session closed** — pending decisions (agent isolation A/B/C) deferred to next session.

## 2026-07-26 - Google read-sidecar FULL DEPLOYED: Calendar + Contacts live with 11 tools

- **Full deploy COMPLETE.** Re-auths done, build done, container recreated, smoke test green via Telegram, and Contacts VCF bulk-imported to Laia's account.
- **11 MCP tools live in production** (3 Gmail + 4 Calendar + 4 Contacts):
  - `gmail_search`, `gmail_get_sanitized`, `calendar_freebusy`, `calendar_list_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `contacts_search`, `contacts_get`, `contacts_create`, `contacts_update`.
- **OAuth tokens live with correct scopes (verified via Google tokeninfo API):**
  - `laia` (`laijmelectronautica@gmail.com`): 5 scopes — `gmail.readonly + calendar.freebusy + calendar.events + contacts + contacts.other.readonly`.
  - `personal` (`dumbo.cata@gmail.com`): 4 scopes — `gmail.readonly + calendar.freebusy + calendar.events.readonly + contacts`.
- **Calendar intercalary LIVE (verified via Telegram):** Both calendars shared via Google Calendar UI; the agent-created event "reunión con equipo" appears in both UIs.
- **Contacts VCF bulk-import to Laia:** 865 of 907 contacts imported via one-off Node script using People API directly. 38 failed with `429 Quota exceeded` (Google's per-minute rate limit on contact creates); user completed the 38 manually via UI. Laia account has ~900+ contacts, all reachable via `contacts_search account=laia`.
- **People API double-namespace bug FIXED:** `google.people({version:'v1',auth:oauth}).people.searchContacts(...)` (not `.searchContacts(...)` directly). Sub-agent shipped single-namespace calls; live container failed with `TypeError: people.searchContacts is not a function`. Fixed in `src/tools.js` (calls) and `test/tools.test.js` (mocks). 21/21 tests green.
- **People API readMask/personFields defaults:** Hardcoded to `names,emailAddresses,phoneNumbers` (search) and `names,emailAddresses,phoneNumbers,organizations,urls` (get) so callers don't have to specify them.
- **Defense-in-depth layers all verified:**
  - Zod schema `writeAccountField = z.enum(['laia'])` for write tools
  - Runtime guard `if (account !== WRITE_ACCOUNT) throw new Error('write operations require the laia account')`
  - Token scope: Javier's `personal` token lacks `calendar.events` and `contacts` (only `.readonly`), so Google API rejects write attempts at the deepest layer
- **Tests: 21/21 pass** in `tools.test.js`. 2 pre-existing `isolation.test.js` failures (compose path drift) are NOT caused by this change.
- **Persona clarification with user:** User's mental model was "OpenClaw has its own Google account and lives inside its own container; my personal accounts stay outside for security." Reality: OpenClaw is a framework that talks to personal Google accounts via OAuth; there's no third Google account. The sidecar is already isolated by Docker (own container, `cap_drop: ALL`, internal network) and uses minimal OAuth scopes. User's instinct to keep personal vs. agent accounts separate is **valid for enterprise use** but adds complexity for personal use. Discovered OpenClaw's native `openclaw agents add` subcommand supports the "secretaria virtual en su propio despacho" pattern via isolated agent workspaces + per-agent allowlists + per-agent Engram.
- **Project hygiene:** Working tree still dirty. `git status` shows untracked `services/google-read-sidecar/`, `services/laia-imap-sidecar/`, `services/planner-sidecar/`, `state/`, `workspace/`, `google-secrets/` (the last is intentionally untracked — secrets). `.gitignore` and `AGENTS.md` root were modified by the Gentle-AI workspace repair session.
- **OpenClaw investment context:** User asked about creating a new GitHub repo for the sidecar standalone. Postponed until architectural direction is decided (consolidate to one account vs. keep two accounts vs. build isolated agent). See `next-session.md`.

## 2026-07-26 - Google read-sidecar People API (Contacts) extension STAGED (code only, no deploy)

- **Code staged for review, NOT deployed.** Javier must re-authorize OAuth tokens via browser PKCE loopback to activate the new contact scopes.
- 4 new MCP tools added: `contacts_search`, `contacts_get`, `contacts_create`, `contacts_update`. Total sidecar surface = 11 tools.
- **Scopes widened**: ALLOWED_SCOPES now contains `gmail.readonly + calendar.freebusy + calendar.events + calendar.events.readonly + contacts + contacts.other.readonly + contacts.readonly`. `contacts.other` (write-shared) is FORBIDDEN. REQUIRED_SCOPES stays at `gmail.readonly + calendar.freebusy`.
- **Account split**: `laia` re-authorized with `contacts + contacts.other.readonly` (write+read own, read shared); `personal` re-authorized with `contacts.readonly` (read-only own). Write tools (`contacts_create`, `contacts_update`) reject `account='personal'` at the runtime layer (defense-in-depth; API also rejects because `personal`'s token lacks `contacts`).
- **`scripts/authorize.js` updated**: `node scripts/authorize.js laia` requests 5 scopes incl. `contacts + contacts.other.readonly`; `... personal` requests 4 scopes incl. `contacts.readonly`.
- **`state/openclaw.json` reconciled**:
  - `tools.allow`: added 4 new `google-read__contacts_*` entries (11 google-read entries total).
  - `tools.deny` and Telegram-direct deny: NO `google-read__contacts_*` entries added (deny always wins at policy matcher; runtime guard + Zod schema + token scope are the real defenses).
  - `mcp.servers.google-read.toolFilter.include`: 11 names in canonical order.
  - `channels.telegram.direct[1345901933].tools.allow`: 11 names; `.deny` unchanged.
- **Tests**: 21/21 in `tools.test.js`. The 2 pre-existing `isolation.test.js` failures (`docker-compose.yml` vs `docker-compose2.yml`) remain — unrelated to this change.
- **People API quirk discovered**: `people.updateContact` uses `updatePersonFields` (comma-separated field names like `names,emailAddresses`), NOT `updateMask`. The People API's update contract is different from Workspace APIs.
- **Docs**: README.md "Purpose and Security Boundary", "Tool Inventory and Redaction", "Data Behavior and Account Coverage", "Non-Goals", "Sources" all updated to mention contacts. `workspace/TOOLS.md` new "Google Contacts" section after "Google Read-Only", with the agent-side rule "ask before contacts_create from IMAP digest senders — do not auto-create from email content."
- **Hard rule honored**: no logs of token JSON, refresh tokens, client secrets, contact payloads, contact resourceNames. Token write keeps `mode 0o600` + chmod.

## 2026-07-26 - Google read-sidecar calendar events extension STAGED (code only, no deploy)

- **Code staged for review, NOT deployed.** User (Javier) has to re-authorize OAuth tokens via browser PKCE loopback to activate the new scopes.
- 4 new MCP tools added: `calendar_list_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`. Total sidecar surface = 7 tools.
- **Scopes widened** (per Javier's explicit acceptance): ALLOWED_SCOPES now contains `gmail.readonly + calendar.freebusy + calendar.events + calendar.events.readonly`. REQUIRED_SCOPES stays at `gmail.readonly + calendar.freebusy` so each per-account token only needs the baseline + its own slot-specific scope.
- **Account split**: `laia` re-authorized with `calendar.events` (write+read), `personal` re-authorized with `calendar.events.readonly` (read-only). Three write tools (`calendar_create_event`, `calendar_update_event`, `calendar_delete_event`) reject `account='personal'` at the runtime layer (defense-in-depth; the API also rejects because the token lacks `calendar.events`).
- **`scripts/authorize.js` slot-aware**: `node scripts/authorize.js laia` and `node scripts/authorize.js personal` re-authorize each slot with the correct scope set. Reuses `resolveAccountPaths` from `google-client.js`.
- **`state/openclaw.json` reconciled**:
  - `tools.allow`: added 4 new `google-read__calendar_*_event` entries.
  - `tools.deny` and Telegram-direct deny: REMOVED the `google-read__calendar_create_event/update_event/delete_event` entries (defense-in-depth deny on the same tool name breaks it because OpenClaw's `isToolAllowedByPolicyName` says "deny always wins"). Kept `google-read__gmail_send` and `google-read__gmail_modify` in deny (Gmail write remains forbidden).
  - `mcp.servers.google-read.toolFilter.include`: 7 names in canonical order.
  - `channels.telegram.direct[1345901933].tools.allow`: 7 names; `.deny`: gmail send/modify only.
- **Tests**: 11/13 pass. The 2 pre-existing failures are isolation-test compose-pattern checks against `docker-compose.yml` (the sidecar lives in `docker-compose2.yml`) — unrelated to this change.
- **Docs**: README.md "Purpose and Security Boundary", "Tool Inventory and Redaction", "Data Behavior", "Troubleshooting", "Non-Goals" all updated. `workspace/TOOLS.md` calendar section rewritten. Stale `dumbo.cat@hotmail.com` references replaced with `laijmelectronautica@gmail.com`.
- **Hard rule honored**: never logged token JSON, refresh tokens, client secrets, message bodies, message IDs. Token write keeps `mode 0o600` + chmod.

## 2026-07-25 - Planner Phase 1 COMPLETE — live desde Telegram con ambos modelos

- **Fase 1 completa**: 7 tools MCP `planner_*` funcionando desde Telegram. DeepSeek y StepFlash leen tareas reales de Planner.
- **Modelo problemático**: StepFlash (step-3.7-flash) rechazaba IDs opacos tipo `vPMzhs0pv0eVUaDArQrrvJgAGMpV` por "no ser UUIDs". Fix: tool descriptions MCP cambiadas a "opaque Microsoft Planner identifier string" sin mencionar UUIDs.
- **Modelo que funciona**: DeepSeek (deepseek-v4-flash) pasa los IDs textuales sin problema.
- **Gateway → sidecar**: después de rebuild/recreate del sidecar, el Gateway necesita restart para refrescar DNS. El error es "Streamable HTTP error: Error POSTing to endpoint: " con URL vacía. Fix: `docker compose restart openclaw-gateway`.
- **Datos reales**: Javier tiene 1 plan "Tareas" con ~33-41 tareas vivas en 5 buckets. User ID: `22efb16a-2366-4c28-84f2-bb4d874da446`.
- **README actualizado**: añadido bugfix de StepFlash/UUID, sección "Live Data", tool descriptions actualizadas, flujo de IDs con ejemplos reales.
- **TOOLS.md actualizado**: regla "CRITICAL: Planner IDs NO son UUIDs" + "StepFlash-hard Rule for Planner" (escalar a GPT si no puede).
- `planner_update_task` y `planner_delete_task` agregados: Fase 2 activa. Update permite marcar completada (percentComplete), mover buckets, cambiar fecha. Delete requiere `confirm: true`.
- `planner_update_task` y `planner_delete_task` requieren If-Match etag de Graph API: el sidecar hace GET previo para obtener `@odata.etag`, luego PATCH/DELETE con el header.
- `planner-state/` ok como `jmon:jmon`.
- Todos los containers healthy.

## 2026-07-25 - Planner sidecar Phase 1 live smoke test PASSED

- Full end-to-end smoke test completed against Javier's real M365 account.
- **Auth**: Device code flow with MSAL Node (`./planner-state/profiles/default/token-cache.json`). Single-tenant app — requiere tenant ID específico en `.env` (`PLANNER_TENANT=a0a2c392-af02-4743-970d-a38e17d82da6`).
- **Docker bugfixes aplicados**:
  - Gateway missing `planner-mcp-internal` network → no podía resolver `planner-sidecar` hostname. Fix: añadida a `docker-compose2.yml`.
  - `services/planner-sidecar/src/login.js`: `import.meta.url` guard fix — `process.argv[1]` es relativo, `import.meta.url` es absoluto. Fix con `path.resolve()` + `fileURLToPath`.
  - `services/planner-sidecar/src/server.js`: MCP "Already connected to a transport" en segundo initialize. Fix con `closeTransport()` antes de `connectTransport()`.
  - `services/planner-sidecar/src/graph-client.js`: `listPlans()` usaba `ownerGroupId` que no existe en `microsoft.graph.plannerPlan`. Fix: `select: 'id,title,owner'`.
- **7 tools MCP verificadas** (MCP initialize + tools/list + tool calls reales):
  - `planner_status` → `{"connected":true,"expiresAt":"1785012178"}`
  - `planner_list_profiles` → `{"profiles":["default"]}`
  - `planner_list_plans` → 1 plan "Tareas" (owner: grupo `b8179882-...`)
  - `planner_list_buckets` → 5 buckets: "Hoy", "Esta semana", "Próxima semana", "Sin pausa pero sin prisa", "Trabajos en activo"
  - `planner_list_tasks` → ~30 tareas devueltas, algunas con assignments al usuario `22efb16a-...`
  - `planner_get_task`, `planner_create_task` — schemas expuestos, no probados con datos reales.
- **Graph endpoint confirmado**: `GET /v1.0/me/planner/plans?$select=id,title,owner&$top=200`. Owner del plan es el Group ID del grupo M365.
- `planner-state/` creado como `jmon:jmon` (antes root-owned por Docker volume). `services/planner-sidecar/package-lock.json` sigue tracked.
- `docker-compose2.yml` modificado: planner-sidecar service, openclaw-gateway networks extendida.
- `state/openclaw.json` ya tiene allowlist (Phase 1 tools) + deny (Phase 2+) + `mcp.servers.planner` config.

## 2026-07-23 - mail_search_in_mailbox date-field contract bug fixed

- Root cause: `services/laia-imap-sidecar/src/tools.js` `searchMailbox` validated `fromDate`/`toDate` strings, converted them to `{ from, to }` Date objects via `validateDateRange`, then forwarded those Date objects to `intake.searchMailbox`. `services/laia-imap-sidecar/src/imap-client.js` `ImapIntake.searchMailbox` re-validates by expecting `input.fromDate`/`input.toDate` strings, so every call threw `fromDate must be a string` before opening any IMAP connection. The MCP `server.js` generic handler hid it as `IMAP read-only intake is unavailable.`.
- Fix: the facade now keeps its mailbox / filter / limit / redact validation, but forwards `fromDate` and `toDate` as raw strings. Intake-side date validation remains authoritative for parsing, inversion, and the 366-day range cap. `validateDateRange` is no longer imported in `tools.js`.
- Test: 41/41 sidecar tests pass under `node --test test/**/*.test.js`. Added three facade-level regression tests: (1) facade forwards exact `fromDate`/`toDate` strings and never forwards `from`/`to` Date objects; (2) intake-side validation throws for malformed/inverted/oversize ranges via the intake contract; (3) facade still validates mailbox path, filter, and clamps limit/redact defaults.
- Server: `server.js` now records only tool name and error constructor name to `stderr` on caught tool errors (`{ event: "imap_tool_failure", tool, error }`). It never logs error message, mailbox path, or mail data. The generic user-visible envelope is unchanged.
- Docs: `workspace/TOOLS.md`, `services/laia-imap-sidecar/README.md`, and `docs/next-session.md` now refer to the actual Hostinger spam path as `INBOX.Junk` and describe the daily flow as one-shot bounded explicit search, not background full-folder ingestion.
- Compose config validated. Only `laia-imap-sidecar` was rebuilt and recreated; gateway and Google sidecar were not restarted. All three containers healthy.
- Authorized live coverage check completed: `mail_list_mailboxes` returned the fresh selectable paths; each unique path was probed once with `mail_search_in_mailbox` (`limit: 2`, default redaction, max 366-day window). Metadata (sender, subject, body, Message-ID, timestamps, credentials) was not reported or persisted.
- `git diff --check` clean. Repository remains intentionally dirty and uncommitted; no commit made.

## 2026-07-23 - Hostinger WITHIN extension compatibility fix in `mail_search_in_mailbox`

- Root cause: `services/laia-imap-sidecar/src/imap-client.js` `ImapIntake.collectMailboxCandidates` passed Date objects to `client.search({ since, before }, { uid: true })`. ImapFlow's `search-compiler.js` emits the `WITHIN` extension (`OLDER`/`YOUNGER` keys) whenever the date value is a Date object AND the server advertises WITHIN. Hostinger advertises WITHIN but rejects `OLDER 0`-class semantics; `ImapFlow.search` returned `false` and the sidecar surfaced it as `IMAP search returned an invalid UID list`.
- Fix: format `since` and `before` as `YYYY-MM-DD` strings via a local `isoDayString(date)` helper so ImapFlow uses standard `SINCE`/`BEFORE` instead of the WITHIN branch. `before` remains the exclusive next-day boundary (`to + 1 day`). `false`/`null` from `client.search` now explicitly fail closed; non-array and malformed responses continue to fail closed.
- Tests: 45/45 sidecar tests pass under `node --test test/**/*.test.js`. Added four tests before the source change: (1) `collectMailboxCandidates` sends string `since`/`before` and `{ uid: true }` (not Date objects); (2) `false` from `client.search` is an error and never triggers `fetchOne`; (3) `[]` from `client.search` is a successful no-match and never triggers `fetchOne`; (4) malformed non-array responses (null/undefined/string/number/object/boolean) reject and never trigger `fetchOne`. The pre-existing "translates the date range" test was updated to assert the new string contract.
- Compose config validated. Only `laia-imap-sidecar` was rebuilt and recreated; gateway and Google sidecar were not restarted. All three containers healthy.
- Authorized live coverage check completed: `mail_list_mailboxes` returned the fresh selectable paths; 32 unique paths were probed once with `mail_search_in_mailbox` (`limit: 2`, default redaction, 30-day window `2026-06-23..2026-07-23`). 32/32 succeeded, 0 failed, 6 folders had at least one candidate (counts 1 or 2), the rest returned `[]`. No sender, subject, body, Message-ID, UID, timestamp, or credential was reported or persisted.
- `git diff --check` clean. Repository remains intentionally dirty and uncommitted; no commit made.

## 2026-07-22 - Gentle-AI delegated-agent and image recovery status

- Global OpenCode changes take effect only in a new session. `~/.config/opencode/opencode.json` routes 20 delegated agents across general, explore, SDD, review, and Judgment Day roles to `minimax/MiniMax-M3`; the primary/orchestrator model was not changed.
- `docker/gentle-ai/download-release.sh` downloads the official Gentle-AI v2.1.11 release on the host and verifies its pinned SHA-256 before the Docker build. `docker/gentle-ai/Dockerfile` embeds only that verified binary into a pinned OpenClaw base image; Docker does not download releases.
- `openclaw-gentle-ai:2.1.11` built successfully. Only the gateway was recreated; the gateway plus the Google and Laia IMAP sidecars are healthy.
- The gateway confirms `gentle-ai 2.1.11`, healthy Engram, and readable workspace `AGENTS.md` and `SOUL.md`.
- VPS workflow: run `./docker/gentle-ai/download-release.sh`, then deploy Compose. Provision secrets separately.
- Future VPS migration plan: `docs/internal/vps-migration.md` preserves the independent host/OpenCode and gateway Engram stores as separate snapshots. It is not executed.

## 2026-07-22 - Laia IMAP read-only folder inventory and bounded search

- Added two new MCP tools to the local `laia-imap-sidecar`: `mail_list_mailboxes` and `mail_search_in_mailbox`.
- `mail_list_mailboxes` performs a fresh IMAP `LIST`, excludes `\\Noselect` and `\\NonExistent` mailboxes, caps at 200 entries, and returns sanitized `path` and `name` strings only — no counts, no status, no message data.
- `mail_search_in_mailbox` opens a read-only IMAP lock on one selectable folder from a fresh list, runs a date-only IMAP search (max 366-day `YYYY-MM-DD` range), fetches only envelope + internalDate, applies sender/subject filters post-fetch, caps at 20 results, and defaults to redacting sender/subject (`redact: false` is the explicit opt-in for raw values).
- It never fetches source/MIME/body, never uses IMAP TEXT or BODY search, and always releases the read-only lock in finally. The existing Inbox+Sent local SQLite intake (`selectSyncMailboxes`) is unchanged; the new tools are daily-use and live, with no local persistence.
- The OpenClaw allowlist (`state/openclaw.json`) was extended: `tools.allow` adds `laia-imap__mail_list_mailboxes` and `laia-imap__mail_search_in_mailbox`; `mcp.servers.laia-imap.toolFilter.include` was reordered to the canonical `TOOL_NAMES` order with the two new names appended. No new deny rules were added; the existing `laia-imap__mail_send|reply|move|delete|flag`, `imap_send|reply|move|delete|flag`, `smtp`, `codex_apps__hostinger_mail__*`, and `http`/`fetch`/`group:*` denials already cover any drift.
- Sidecar tests: 38 passing under `node --test test/**/*.test.js`. Compose config validates. Only `laia-imap-sidecar` was rebuilt and recreated; gateway and Google sidecar were not restarted.
- One live `mail_list_mailboxes` probe returned 32 selectable folders. On this Hostinger account the user's "Unwanted / No Deseado" maps to `INBOX.Junk`.
- Hostinger uses flat `INBOX.<Folder>` naming (e.g. `INBOX.Sent`, `INBOX.Drafts`, `INBOX.Junk`, `INBOX.Trash`). The previously inferred "non-Inbox/Sent folders exist" question is now answered by a fresh list instead of guesses.

## 2026-07-22 - Gentle-AI workspace repair

- Gentle-AI 2.1.11 was already installed; its doctor reports Engram healthy. The host `openclaw` CLI is absent from `PATH`, and OpenCode has duplicate `PATH` entries.
- An interrupted install incorrectly placed the managed SDD orchestrator block in root `AGENTS.md` and the persona in root `SOUL.md`.
- The repair moved the complete managed SDD block to `workspace/AGENTS.md` and the complete persona block to `workspace/SOUL.md`. Root `AGENTS.md` now contains OpenClaw upstream-only rules, and root `SOUL.md` was removed.
- Docker Compose mounts `/home/jmon/openclaw/workspace` at `/home/node/.openclaw/workspace` in the gateway; the gateway confirmed both workspace files are visible.
- No service restart occurred. The gateway and Google-read and Laia-IMAP sidecars remained healthy; Compose config and diff checks passed.
- The repository remains intentionally dirty and uncommitted. `docker-compose.yml` and `.gitignore` predate this repair and require separate review and application; do not commit them blindly.

## 2026-07-21 - Direct email app boundary incident

- Native Codex connected apps are explicitly disabled for the Laia agent with `plugins.entries.codex.config.codexPlugins.enabled: false`.
- The OpenClaw tool policy also denies the Codex app namespace plus direct runtime, web, browser, HTTP, and fetch surfaces.
- Approved email access remains limited to the three `laia-imap` read-only MCP tools. Google read MCP and isolated Engram MCP remain configured.
- The gateway was recreated and is healthy; Google and IMAP sidecars were not restarted.
- The audited incident transcript executed only Hostinger read/list calls with HTTP GET; no email write, delete, send, move, flag, or SMTP tool call was executed.
# 2026-07-21 — Laia IMAP 30-day bootstrap window applied locally

- Added `IMAP_BOOTSTRAP_DAYS` with a default of 30 and strict 1–365 integer validation to the isolated read-only IMAP sidecar.
- First sync now uses a read-only `UIDNEXT` high-watermark plus exact `internalDate` cutoff filtering, then seeds the cursor so subsequent polls query only new UIDs. The IMAP `SINCE` query begins one UTC calendar day earlier to avoid timezone/date-boundary misses.
- Backed up only the previous local sidecar SQLite state to `backups/2026-07-21T123716Z-laia-imap-bootstrap-state/`, reset only `imap-state/`, rebuilt/recreated `laia-imap-sidecar`, and completed one bounded live read-only sync without exposing email data.
- Sidecar tests pass 12/12, Compose validation passes, and both sidecar and Gateway health checks pass. No remote mailbox, Google, Engram, Logbook, credentials, or unrelated state was modified.

## 2026-07-21 - IMAP bootstrap recent-mail regression fixed

- Removed the bootstrap's 50-UID truncation before cursor persistence. The old ordering imported only the earliest recent UIDs but advanced to `UIDNEXT - 1`, permanently skipping later messages, including messages received today.
- Hostinger did not advertise its Sent folder with `\\Sent`; the sidecar now prefers the IMAP special-use attribute and otherwise recognizes only a bounded standard sent-folder name allowlist. Inbox and Sent retain independent UIDVALIDITY/UID cursors.
- Backed up the local cache to `backups/2026-07-21T-live-bootstrap-regression-pre-reset/`, reset only `imap-state/`, rebuilt/recreated only `laia-imap-sidecar`, and triggered the production MCP sync.
- Sidecar tests pass 14/14, Compose validation and Gateway health pass. A read-only aggregate probe found 5 messages in the past 24 hours across both selected mailboxes; no mail content or metadata was exposed.
