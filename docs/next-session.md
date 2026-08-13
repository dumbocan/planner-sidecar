# Next Session

## Gateway incident repair (2026-08-13) — closed

- pdf-tool EAI_AGAIN fixed: gateway was missing `pdf-mcp-internal` network in docker-compose2.yml (only sidecars had it); added + recreated. Now resolves and MCP responds.
- Config chmod 600, TTS legacy key migrated (doctor --fix), 5 orphan cron sessions pruned, 99 orphan transcripts archived (reversible rename), bonjour disabled (.env).
- **Pending minor**: tools.allow `tool_search` unknown-entry warning; bootstrap files truncated. Optionally commit the compose network fix.

## Gentle-AI Docker deploy upgraded 2.1.11 → 2.3.0 (2026-08-13)

- Deploy sources (`docker/gentle-ai/*`, `workspace/docker/gentle-ai/Dockerfile`, `docker-compose2.yml` tag, `docs/internal/vps-migration.md`) updated to official Gentle-AI **v2.3.0** with verified checksums; artifact downloaded and checksum-verified.
- Gateway rebuilt and recreated (`openclaw-gentle-ai:2.3.0`): container healthy, `gentle-ai --version` inside reports 2.3.0, sidecars untouched.

## Calendar + audio transcription both FIXED (2026-08-03) — closed

- **Google-read calendar**: BOTH refresh tokens had been revoked by Google (`invalid_grant`) — re-authed laia (`token.json`) and personal (`gmail-dumbo-cata-token.json`) via PKCE loopback, sidecar recreated with `--force-recreate`, MCP verified for both accounts, cron `14babf87` runs clean (ok, delivered, 0 consecutive errors).
- **Audio transcription**: local faster-whisper installed INSIDE the gateway container (venv + model at `state/local-tools/`, wrapper `services/transcribe.py`), config `tools.media.audio.models` switched from broken OpenAI entry (no key) to local CLI. Verified: wrapper exit 0, transcribes; Javier confirmed via Telegram that voice notes transcribe.
- **Still open (product)**: whether the nightly summary should prioritize `personal` (dumbo.cata) or `laia` — Javier's events currently live in laia's calendar. The wording "Cuenta personal no disponible" may confuse if personal returns OK-empty.
- **Worth knowing**: Google can revoke tokens again without warning; the MCP repro lives at `/tmp/opencode/mcp-repro.cjs` (POST initialize + tools/call to /mcp port 3000). If the gateway is ever `--force-recreate`d, the faster-whisper venv/model survive because they live under `state/local-tools/` (bind-mounted).

## Architectural decision pending (HIGH priority, 2026-07-26)

Javier's vision: a "virtual secretary" agent (Laia) with its own workspace, isolated credentials, and a focused tool surface — to keep his personal Google accounts separate from the agent's actions ("if they hack her, they don't hack me").

What we have today (NOT aligned with the vision):

- Single `main` agent in OpenClaw
- Two Google accounts wired into the sidecar (both owned by Javier: `laijmelectronautica@gmail.com`, `dumbo.cata@gmail.com`)
- Token-based isolation only at scopes layer, not at credentials layer
- All tools exposed to the main session, no per-agent allowlists active

What OpenClaw natively supports (discovered 2026-07-26):

- `openclaw agents add` creates **isolated agents** with their own workspaces, auth routing, and tool allowlists
- `isolated-engram` MCP is already referenced in `state/openclaw.json` but the agent surface is not yet built
- WhatsApp is a built-in channel (no separate sidecar needed for the user's planned WhatsApp integration)
- `agent-runtime-architecture.md` describes the runtime layout in detail

Three options for the next session (Javier hasn't picked):

**Option A — Build the isolated "secretaria" agent** (recommended if Javier wants the isolation model)

- `openclaw agents add laia-secretaria --workspace ~/.openclaw/laia --channel telegram --account laia`
- Configure per-agent allowlist (only calendar/contacts tools; NO gmail to start)
- Configure per-agent Engram (already has the `isolated-engram` MCP stub)
- Wire a separate Telegram bot token for the secretary's chat vs. Javier's personal chat
- Sidecar stays shared but per-agent routing ensures Laia's tokens never reach Javier's session

**Option B — Consolidate to one account** (recommended if Javier doesn't actually need cross-account isolation)

- Update the sidecar to remove slot=laia; everything happens on `dumbo.cata@gmail.com`
- Delete the `laijmelectronautica@gmail.com` token and its secrets directory (optional)
- Loses: calendar intercalary, separate agent identity
- Gains: one less surface, simpler config

**Option C — Keep current setup + add docs explaining the model**

- Accept that both accounts are Javier's, document the shared-ownership model
- Skip the isolated-agent pattern for now (can add later if needed)
- Spend time on other gaps (WhatsApp real use, Planner retest, IMAP digest review)

Javier's confusion in the previous session: he expected an "agent-only Google account" that was part of the architecture. Reality: all accounts are his personal. The persona should validate his concern about compartmentalization but be clear that OpenClaw doesn't ship with its own Google account — accounts are always the operator's.

Reopen with: ask Javier which option (A/B/C) he wants before touching code. Default safety: option A satisfies his stated security concern. Option B is simplest if he's okay letting Laia act on his accounts directly.

## Google read-sidecar Phase 3 — People API (Contacts) STAGED, awaiting OAuth re-auth

- ✅ 4 new contact tools (`contacts_search`, `contacts_get`, `contacts_create`, `contacts_update`) STAGED. 21/21 `tools.test.js` pass.
- ⚠️ Javier must re-authorize `laia` and `personal` with the new contact scopes via PKCE loopback. Without this, the sidecar starts but `validateGrantedScopes` fails at first refresh.
- Comando `laia`: `docker run --rm --network host --user 1000:1000 -v "$PWD/google-secrets:/run/secrets/google-read-only" openclaw-google-read-sidecar:local node scripts/authorize.js laia`
- Comando `personal`: `docker run --rm --network host --user 1000:1000 -v "$PWD/google-secrets:/run/secrets/google-read-only" openclaw-google-read-sidecar:local node scripts/authorize.js personal`
- Browser URL (laia): `https://accounts.google.com/o/oauth2/v2/auth?...&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.freebusy%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcontacts%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcontacts.other.readonly&...` — Javier must approve 5 scopes.
- Browser URL (personal): same flow with `contacts.readonly` instead of `contacts + contacts.other.readonly` — 4 scopes.
- After re-auth: `docker compose build google-read-sidecar && docker compose up -d google-read-sidecar` (do NOT recreate gateway or IMAP sidecar).
- If the Gateway loses connection after recreating the sidecar: `docker compose restart openclaw-gateway`.
- **Google Contacts UI sharing** (one-time, Javier does it manually): on `dumbo.cata@gmail.com`, open Contacts → "Mis contactos" label → share with `laijmelectronautica@gmail.com`. This makes personal's contacts searchable via `account: "personal"`. The sidecar does not configure this share.
- **Agent-side rule**: when `laia-imap__mail_list_digest_candidates` returns a sender that does NOT match any contact in `contacts_search`, the agent MUST ask Javier before calling `contacts_create`. Auto-creation from email content is forbidden.
- **Pre-existing failure NOT caused by this change**: `test/isolation.test.js` reads `docker-compose.yml` but the sidecar lives in `docker-compose2.yml`. Fix requires updating the path in `isolation.test.js` to `docker-compose2.yml` — out of scope here.

## Google read-sidecar Phase 2 — calendar events STAGED, awaiting OAuth re-auth

- ✅ 7 tools MCP `google-read__*` funcionando desde código nuevo. `calendar_create_event`, `calendar_update_event`, `calendar_delete_event` rechazan `account='personal'` en runtime Y en Google API layer.
- ⚠️ Javier debe re-autorizar `laia` y `personal` con los scopes nuevos via PKCE loopback. Sin esto, el sidecar arranca pero `validateGrantedScopes` falla al primer refresh.
- Comando `laia`: `docker run --rm --network host --user 1000:1000 -v "$PWD/google-secrets:/run/secrets/google-read-only" openclaw-google-read-sidecar:local node scripts/authorize.js laia`
- Comando `personal`: `docker run --rm --network host --user 1000:1000 -v "$PWD/google-secrets:/run/secrets/google-read-only" openclaw-google-read-sidecar:local node scripts/authorize.js personal`
- Browser URL: `https://accounts.google.com/o/oauth2/v2/auth?...&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.freebusy%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events[.readonly]&...` — Javier debe aprobar los 3 scopes.
- Después de re-auth: `docker compose build google-read-sidecar && docker compose up -d google-read-sidecar` (NO recrear gateway, NO recrear IMAP sidecar).
- Si el Gateway deja de conectar después de recrear el sidecar: `docker compose restart openclaw-gateway`.
- **Pre-existing failure NOT caused by my change**: `test/isolation.test.js` lee `docker-compose.yml` pero el sidecar vive en `docker-compose2.yml`. Los 2 tests de isolation fallan por infraestructura drift, no por código. Para fixear: actualizar el path en `isolation.test.js` a `docker-compose2.yml` (requiere decisión del usuario; archivo fuera del scope de esta task).

## Planner sidecar — Fase 1 completa

- ✅ 7 tools MCP funcionando desde Telegram con DeepSeek. StepFlash también funciona (después de fix en tool descriptions).
- Bugfixes: `ownerGroupId`, `import.meta.url`, MCP closeTransport, Gateway network, tool descriptions UUID framing.
- `planner_create_task` y `planner_get_task` no probados aún — probar en próxima sesión si hay caso real.
- Si el Gateway deja de conectar después de recrear el sidecar: `docker compose restart openclaw-gateway`.
- Extensiones futuras (Fase 2+): `planner_update_task` cuando Javier quiera mover tarjetas; `planner_delete_task` cuando quiera borrar; asignación a terceros cuando justifique; multi-perfil cuando sume un segundo usuario. Cada uno, cuando aparezca el caso real.

## Laia IMAP folder coverage retest

- The sidecar now exposes `mail_list_mailboxes` and `mail_search_in_mailbox`. Re-test through Telegram with a `/new` session before relying on daily coverage.
- Use this prompt: `Consulta los candidatos de correo de hoy o de las últimas 24 horas y muestra como máximo 5 resultados, sin citar ni revelar contenido, direcciones, asuntos ni identificadores.`
- If the agent asks which folders exist, it should call `mail_list_mailboxes` first and use the returned exact paths in `mail_search_in_mailbox`. Never pass wildcard paths; the tool rejects them.
- For a broad sweep including `Unwanted`/`No Deseado`, the agent must call `mail_search_in_mailbox` against `INBOX.Junk` (the Hostinger equivalent on this account) and any other folder Javier asks for. Never claim coverage of `Unwanted`/`No Deseado` without checking `INBOX.Junk`. The Hostinger account uses flat `INBOX.<Folder>` naming; `mail_list_mailboxes` is the only authoritative source of the actual path.
- Each `mail_search_in_mailbox` call is a one-shot bounded daily search: an explicit mailbox path, an explicit date range (max 366 days, `YYYY-MM-DD`), and a bounded limit (default 20). It is NOT a background full-folder ingestion and never replaces the existing Inbox/Sent intake. Re-list folders and run one bounded search per folder Javier actually needs.
- Redaction is the default. The agent should not pass `redact: false` unless Javier explicitly asks for raw sender/subject.
- The existing Inbox+Sent intake, `selectSyncMailboxes`, and local SQLite cache are untouched. The new tools are live IMAP reads that never persist remote mailboxes.
- The MCP `server.js` generic envelope remains `IMAP read-only intake is unavailable.` for caught tool errors; it logs only the tool name and error constructor name to `stderr` and never logs error messages, mailbox paths, or mail data.

## Gentle-AI recovery follow-up

- Global OpenCode changes take effect only in a new session. `~/.config/opencode/opencode.json` routes 20 delegated general, explore, SDD, review, and Judgment Day agents to `minimax/MiniMax-M3`; the primary/orchestrator model was not changed.
- `docker/gentle-ai/download-release.sh` downloads the official Gentle-AI v2.1.11 release on the host and verifies its pinned SHA-256 before Docker build. `docker/gentle-ai/Dockerfile` embeds only the verified binary into a pinned OpenClaw base image; Docker itself does not download releases.
- `openclaw-gentle-ai:2.1.11` built successfully. Only the gateway was recreated; the gateway plus Google and Laia IMAP sidecars are healthy.
- The gateway confirms `gentle-ai 2.1.11`, healthy Engram, and readable workspace `AGENTS.md` and `SOUL.md`.
- VPS workflow: run `./docker/gentle-ai/download-release.sh`, then deploy Compose. Provision secrets separately.
- Before any approved VPS cutover, follow `docs/internal/vps-migration.md`; it is a future plan that keeps the two Engram stores separate and does not authorize service changes.

## Gentle-AI recovery follow-up

- The managed SDD and persona instructions now belong only in `workspace/AGENTS.md` and `workspace/SOUL.md`, which the gateway mounts at `/home/node/.openclaw/workspace`.
- Do not restore managed instructions to root `AGENTS.md` or root `SOUL.md`, restart services for this repair, or commit the dirty repository blindly.
- Review `docker-compose.yml` and `.gitignore` separately before any application or commit; both predate this repair.

## Telegram retest

- Start a new Telegram session with `/new`; existing Codex threads keep their previous app set.
- Use the safe catalog-only retest prompt recorded in the incident handoff before any bounded IMAP query.
- Do not re-enable `codexPlugins` or add direct email-provider app tools. Company email must continue through `laia-imap-sidecar` only.

## Laia IMAP bootstrap follow-up

- The sidecar now starts routine digest intake at a 30-day first-sync boundary and has a fresh local cursor/state cache.
- Re-test through Telegram with: `Consulta los candidatos de correo de hoy o de las últimas 24 horas y muestra como máximo 5 resultados, sin citar ni revelar contenido, direcciones, asuntos ni identificadores.`
- Keep the existing boundary: only the three `laia-imap` read-only MCP tools; no direct Hostinger/Codex Apps, SMTP, writes, or mailbox mutation.
