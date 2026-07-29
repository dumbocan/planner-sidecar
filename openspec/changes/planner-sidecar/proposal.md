# Proposal: Planner Sidecar (Fase 1)

## Intent

Build an isolated MCP sidecar (`services/planner-sidecar/`) that connects Javier's personal Microsoft 365 account to Planner via Microsoft Graph, exposing a narrow read + self-create surface so Laia can answer bounded questions about plans/tasks and create cards when the case justifies it. Closes the gap: today there is no read-side Planner integration exposed to Laia (`extensions/msteams/` is team-owned and out of scope) and no write-side path that respects the narrow-waist principle. Follows the same architectural skeleton as `services/laia-imap-sidecar/` (Streamable HTTP MCP, container sandbox, secrets out of agent, generic error envelope, audit log on stderr only). Authoritative operator intent lives in `docs/internal/planner-sidecar-proposal.md`; this OpenSpec artifact captures the contract that downstream `sdd-spec`, `sdd-design`, and `sdd-tasks` phases will refine.

## Scope

### In Scope (Fase 1)

- New sidecar at `services/planner-sidecar/` mirroring the laia-imap skeleton: `src/{server.js,graph-client.js,auth.js,profile-store.js,tools.js,login.js}`, `test/sidecar.test.js`, `Dockerfile`, `package.json`, `README.md`, `.env.example`.
- 7 MCP tools (Streamable HTTP on `/mcp`) over `@modelcontextprotocol/sdk` + zod: `planner_list_profiles`, `planner_status`, `planner_list_plans`, `planner_list_buckets`, `planner_list_tasks`, `planner_get_task`, `planner_create_task`.
- Auth via MSAL Node device code flow, CLI-only (`node src/login.js <profile>`), not an MCP tool. Token cache at `./planner-state/profiles/<id>/token-cache.json` (mode `0600`, owner `1000:1000`).
- Graph delegated permissions: `Tasks.ReadWrite` (minimum needed; Microsoft has no create-only) + `Group.Read.All` (resolve plan owner group).
- Output sanitization: titles returned as-is; descriptions truncated to 500 chars by default; full description only with explicit `include_full_description: true` (registered to stderr).
- Audit log shape (stderr JSON only): `{event: 'planner_tool_call', tool, profile, result_count, duration_ms}` and `{event: 'planner_tool_failure', tool, profile, error: <constructor_name>}`.
- Container sandbox: `user: "1000:1000"`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges: true`, `init: true`, `tmpfs: /tmp:rw,noexec,nosuid,size=64m`, no host port mapping; reachable only on `planner-mcp-internal` network; egress limited to `graph.microsoft.com` + `login.microsoftonline.com` via `planner-egress`.
- Strict TDD: failing `node --test test/**/*.test.js` first; regression test fails if `TOOL_NAMES` ever includes `update_task`, `delete_task`, `create_plan`, `create_bucket`, or `assignee_email`.
- `state/openclaw.json` allowlist + `mcp.servers.planner` block + defensive deny rules (delivered in `sdd-spec`, NOT applied at proposal time — sidecar must exist and be healthy first).
- `.gitignore` additions: `/planner-state/`, `/.env.planner`.

### Out of Scope (Fase 1 Non-Goals)

- `planner_update_task`, `planner_delete_task`, `planner_create_plan`, `planner_create_bucket`.
- `assignee_email` on `planner_create_task`; the tool always self-assigns to the authenticated user.
- Reading attachments, comments, checklists, external references.
- Token presence in `.env`, Compose, `state/openclaw.json`, workspace, Gateway, CLI, or Engram.
- Reusing `extensions/msteams/` Graph code or any Codex Apps for Planner.
- Editing `docker-compose.yml`, the Gateway, or other sidecars to "fix" this sidecar.

## Capabilities

### New Capabilities

- `mcp-planner-tools`: the 7-tool MCP surface for read + self-create against Microsoft Graph Planner. Each tool is a zod-validated schema with a sanitized output contract and a `profile?` arg accepted but ignored today.

### Modified Capabilities

- None. `openspec/specs/` does not yet exist for this repo; this is the first OpenSpec change. No existing capability is changed.

## Approach

Mirror the laia-imap pattern one-for-one. `src/server.js` hosts `McpServer` + `StreamableHTTPServerTransport`, validates method/path on `/mcp` (`POST`/`GET`/`DELETE`), returns the generic envelope `Planner sidecar is unavailable.` on every caught tool error, and emits the audit log JSON to stderr with the error constructor name only. `src/tools.js` wires the 7 zod schemas to a thin `src/graph-client.js` fetch wrapper (raw `https://graph.microsoft.com/v1.0/...` — no Graph SDK needed for Fase 1 surface). `src/auth.js` wraps `@azure/msal-node` `PublicClientApplication` with `CachePlugin` writing to `./planner-state/profiles/<id>/token-cache.json`; `src/login.js` is a one-shot CLI that drives the device-code flow and exits. `src/profile-store.js` enumerates profile directories and isolates caches. `src/profile-store.js` + `src/auth.js` already accept `<profile>` everywhere — Fase 6 turns the stub selector into a real dispatcher. Tests use `node --test` with mocked MSAL + mocked `fetch`; never hit real Graph. Build with `node --test test/**/*.test.js` green as the merge gate.

## Security Model

| Surface | Contract |
|---|---|
| Graph delegated permissions | `Tasks.ReadWrite` + `Group.Read.All`; no app-only, no client credentials, no org-level |
| Token cache | `./planner-state/profiles/<id>/token-cache.json`, mode `0600`, owner `1000:1000`, mounted `ro` except `profiles/<id>/` |
| Auth entry point | `node src/login.js <profile>` (CLI), never an MCP tool |
| Token refresh | MSAL automatic; failure → next tool returns generic envelope, operator re-runs `login.js` |
| Tool surface | 7 tools; `profile?` arg accepted but ignored (Fase 6 wires real selector) |
| Sanitization | `title` as-is; `description` truncated to 500 chars; opt-in full description is logged |
| MCP error envelope | Always `Planner sidecar is unavailable.` — no stack, IDs, paths, content |
| Audit log | stderr JSON only: `{event: 'planner_tool_call', tool, profile, result_count, duration_ms}` or `{event: 'planner_tool_failure', tool, profile, error: <constructor_name>}` |
| Container | `user: "1000:1000"`, `read_only`, `cap_drop: ALL`, `no-new-privileges`, `init`, `tmpfs: /tmp:rw,noexec,nosuid,size=64m`, no host port, internal network only |

## Auth Flow

1. Operator runs `docker compose exec planner-sidecar node src/login.js default`.
2. Sidecar prints `To sign in, open https://microsoft.com/devicelogin and enter: <code>`.
3. Operator consents in browser (one-time consent for `Tasks.ReadWrite` + `Group.Read.All`).
4. Sidecar polls token endpoint until success or 15 min timeout.
5. Cache persists at `./planner-state/profiles/default/token-cache.json` (mode `0600`).
6. Operator confirms to Laia: "Planner conectado". From then on, MSAL refreshes silently.

## Profile Abstraction

`src/profile-store.js` and `src/auth.js` already accept a `<profile>` argument everywhere (CLI and every tool). Today exactly one profile (`default`) is loaded; `planner_list_profiles` returns `["default"]`. The selector is a stub that Fase 6 turns into a real per-request dispatcher. The hook ships in Fase 1 so Fase 6 is purely additive.

## MCP Tools (Fase 1)

All inputs pass zod validation at the boundary. `profile?` is accepted on every tool but ignored today (default `default`).

| Tool | Input (zod) | Output |
|---|---|---|
| `planner_list_profiles` | — | `{profiles: ["default"]}` |
| `planner_status` | `profile?` | `{connected: bool, expiresAt?: string}` |
| `planner_list_plans` | `profile?` | `[{id, title, ownerGroupId}]` |
| `planner_list_buckets` | `plan_id: z.string().uuid()`, `profile?` | `[{id, name, orderHint}]` |
| `planner_list_tasks` | `plan_id`, `bucket_id?: uuid`, `due_before?: YYYY-MM-DD`, `due_after?: YYYY-MM-DD`, `assigned_to_me?: bool`, `profile?` | `[{id, title, dueDateTime?, bucketId, assignments: string[]}]` |
| `planner_get_task` | `task_id: uuid`, `profile?`, `include_full_description?: bool` | `{id, title, bucketId, dueDateTime?, assignments, description?}` (500 chars default) |
| `planner_create_task` | `plan_id`, `bucket_id`, `title (1..256)`, `due_date?: YYYY-MM-DD`, `profile?` | `{id, title, bucketId, dueDateTime?}` — always self-assigned |

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `services/planner-sidecar/**` | New | Sidecar implementation (Fase 1) |
| `state/openclaw.json` | Modified (spec only) | Allowlist + `mcp.servers.planner` + deny rules — applied only after sidecar is healthy |
| `docker-compose.yml` | Modified (spec only) | `planner-sidecar` service, internal/egress networks, no host port |
| `.gitignore` | Modified (spec only) | `/planner-state/`, `/.env.planner` |
| `services/laia-imap-sidecar/**` | None | Reference pattern only, no runtime dependency |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Token leak to logs/Engram/Gateway | Low | Audit-log test asserts no token string in captured stderr; `.env`/state files forbidden by Non-Goals |
| Scope drift past Fase 1 (update/delete/assign-a-terceros) | Medium | `TOOL_NAMES` regression test fails on any added update/delete/create_plan/create_bucket/assignee_email; deny rules in `state/openclaw.json` |
| Microsoft Graph `Tasks.ReadWrite` wider than needed | Medium | Documented; Fase 2/3/4 only widen if a real case demands it |
| Profile abstraction grows stale (only `default` loaded) | Low | Hook exercised by `planner_list_profiles` + `login.js <id>`; Fase 6 picks it up |
| Container breakout via injected token | Low | `read_only`, `cap_drop: ALL`, `no-new-privileges`, internal-only network, egress-limited |
| Allowlist edit applied before sidecar is healthy | Medium | Spec is explicit: `state/openclaw.json` edits land in `sdd-spec` but are not applied until sidecar passes `/healthz` |

## Rollback Plan

Fase 1 is purely additive. To revert:
1. Stop and remove `planner-sidecar` Compose service.
2. Revert `state/openclaw.json` allowlist and `mcp.servers.planner` block.
3. Delete `./planner-state/` host volume.
4. Redeploy Gateway. `services/laia-imap-sidecar/` and `extensions/msteams/` are untouched.

## Dependencies

- `services/laia-imap-sidecar/` — reference pattern only; no runtime coupling.
- `@azure/msal-node` — PublicClientApplication + CachePlugin for device code + token cache.
- `@modelcontextprotocol/sdk` + `zod` — same as the IMAP sidecar.
- Microsoft 365 tenant (developer or production) with consent for `Tasks.ReadWrite` + `Group.Read.All`.

## Success Criteria

- [ ] `node --test test/**/*.test.js` runs green with no network and no Docker.
- [ ] `TOOL_NAMES` exports exactly 7 names; regression test fails on any update/delete/create_plan/create_bucket/assignee_email addition.
- [ ] `state/openclaw.json` allowlist + `mcp.servers.planner` block + deny rules applied; `/healthz` returns 200; one device-code login succeeds end-to-end with Javier's real account.
- [ ] No token, title, description, task ID, due-date, or error message appears in any log capture or stderr stream.
- [ ] `Dockerfile` + `docker-compose.yml` snippet build and start the service; container reports healthy.
- [ ] README documents Quick Path, Security Boundary, Runtime Architecture, Tool Inventory, Non-Goals.

## Roadmap (each phase triggered by a real case)

| Fase | Trigger | Surface added |
|---|---|---|
| 2 | Real "move/rename this card" case | `planner_update_task` (own tasks only) |
| 3 | Real "delete this card" case | `planner_delete_task` (own tasks only, explicit confirm) |
| 4 | Real "assign to X" case | `planner_create_task.assignee_email` validated against Graph |
| 5 | Real "create a board" case | `planner_create_plan`, `planner_create_bucket` |
| 6 | Second profile loaded | Real `profile` selector across all tools |

If a trigger does not arrive, the phase does not ship. Engram decision `planner-sidecar/fase-1` (#2395) and pattern `sidecar/security-pattern` (#2396) anchor this discipline.

## Sources

- Operator intent — `docs/internal/planner-sidecar-proposal.md` (authoritative for Fase 1 scope)
- Microsoft Graph Planner overview — `https://learn.microsoft.com/en-us/graph/api/resources/planner-overview`
- MSAL Node device code flow — `https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code`
- MSAL Node token-cache serialization — `https://learn.microsoft.com/en-us/entra/msal/node/how-to/token-cache-serialization`
- OpenClaw MCP allowlist convention — `state/openclaw.json` `laia-imap` block as reference
- Sidecar reference pattern — `services/laia-imap-sidecar/{README.md,src/server.js,src/tools.js}`
- Engram — `planner-sidecar/fase-1` (#2395), `sidecar/security-pattern` (#2396), `sdd-init/openclaw` (#2397)
