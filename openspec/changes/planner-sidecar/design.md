# Design: Planner Sidecar (Fase 1)

## Purpose

Technical design for the `services/planner-sidecar/` MCP sidecar. Adds read + self-create against Microsoft Graph Planner (7 tools, MSAL device-code CLI, hardened container, generic error envelope). Mirrors the laia-imap skeleton: `services/laia-imap-sidecar/{server.js,tools.js,imap-client.js}` is the structural reference. Implements the spec at `openspec/changes/planner-sidecar/spec.md` (22 scenarios) one-for-one. Fase 2-6 are documented as design seams only and ship when their real trigger case arrives (Engram `#2395`).

## Architecture

### Runtime topology

```
services/planner-sidecar (container, user 1000:1000, read_only)
├── /healthz  ──── GET (Compose healthcheck)
├── /mcp      ──── POST/GET/DELETE  (Streamable HTTP, MCP transport)
│
└── Node process
    ├── server.js          HTTP + McpServer + StreamableHTTPServerTransport
    ├── tools.js           zod schemas + 7 tool implementations + TOOL_NAMES
    ├── graph-client.js    thin fetch wrapper, https://graph.microsoft.com/v1.0
    ├── auth.js            MSAL PublicClientApplication + custom ICachePlugin
    ├── profile-store.js   enumerates ./planner-state/profiles/<id>/
    └── login.js           CLI: one-shot device-code flow (NOT an MCP tool)

External:
  microsoft.com/devicelogin    device-code UI (operator browser)
  login.microsoftonline.com    token endpoint
  graph.microsoft.com          Graph API
```

Token cache lives at `./planner-state/profiles/<id>/token-cache.json` (mode `0600`, owner `1000:1000`). Mounted into the container with `profiles/<id>/` writable, rest read-only.

### Architecture decisions

| Option | Tradeoff | Decision |
|---|---|---|
| `@microsoft/microsoft-graph-client` vs raw `fetch` | SDK adds typings, retry, paging — overkill for 7 read/list/create calls | Raw `fetch` against `/v1.0/...`; same `StreamableHTTPServerTransport` import as IMAP sidecar |
| `PublicClientApplication` device code vs auth code PKCE | Device code needs no public URL, fits a headless container | Device code; `login.js` is a CLI one-shot, not a tool |
| Single profile `default` today, multi-profile later | Hook (CLI arg + per-tool arg) ships now so Fase 6 is purely additive | `profile` arg accepted on every tool, ignored; `auth.js` keyed by profile id |
| Local token cache file vs OS keychain | Keychain is non-portable across containers; file with `0600` matches IMAP-sidecar `imap-secrets` pattern | File at `./planner-state/profiles/<id>/token-cache.json` |
| `pnpm` (monorepo) vs `npm ci` (standalone service) | Planner-sidecar is a standalone container, not part of the pnpm workspace | Match IMAP sidecar: own `package.json` + `npm ci` in Dockerfile |

## Module boundaries

| Module | Responsibility | Public exports | Internal deps | Failure modes | Test surface |
|---|---|---|---|---|---|
| `auth.js` | MSAL PublicClientApplication + custom ICachePlugin reading/writing the token cache file; silent refresh | `createAuthClient({profile, stateDir}): AuthClient`; `AuthClient.acquireToken(scopes): Promise<{accessToken, expiresOn}>` | `profile-store.js`, `node:fs/promises`, `@azure/msal-node` | Throws `AuthError` on token-cache I/O failure and on MSAL refresh failure; never throws raw MSAL errors to MCP | Unit: cache load/save round-trip; refresh returns new token; `acquireToken` rejects on missing cache |
| `profile-store.js` | Enumerate, validate, and isolate profile directories under `stateDir/profiles/` | `listProfiles(): string[]`; `profileDir(id): string`; `validateProfileId(id): void` | `node:fs/promises`, `node:path` | Throws on invalid id (regex `^[a-z0-9-]{1,64}$`) or unwritable parent | Unit: rejects `..`, uppercase, slash; creates dir with `0700`; isolates caches between profiles |
| `graph-client.js` | One method per Graph endpoint the spec uses; constructs URL, attaches bearer, surfaces status only | `listPlans()`; `listBuckets(planId)`; `listTasks(planId, {bucketId, dueBefore, dueAfter, assignedToMe})`; `getTask(taskId)`; `createTask({planId, bucketId, title, dueDate})`; `getMe()` | `auth.js`, `node:fetch` (global) | Throws `GraphError({status, code})`; never throws raw Response; never throws string snippets from Graph body | Unit: URL is built with `$top=200`; 401 triggers one refresh; 4xx mapped to `GraphError`; 5xx retried with backoff up to 2 |
| `tools.js` | 7 zod-validated tools, sanitization, self-assignment for `create`, audit-log dispatch | `TOOL_NAMES` (7 strings); `createPlannerTools({auth, graph}): {listProfiles, status, listPlans, listBuckets, listTasks, getTask, createTask}` | `graph-client.js`, `auth.js`, `zod` | Throws on zod failure (caught by `server.js`); sanitization never throws | TDD per spec: one failing test per `#### Scenario:` block (22 minimum) |
| `server.js` | HTTP + McpServer + StreamableHTTPServerTransport; `/healthz`; zod-validated inputs; generic envelope; audit log to stderr | default-export `listen(port)` | `tools.js`, `@modelcontextprotocol/sdk` | Always catches and returns `Planner sidecar is unavailable.`; logs `{event, tool, profile, ...}` | Integration: `/mcp` accepts POST/GET/DELETE only; healthcheck returns `200`; one audit line per call |
| `login.js` | One-shot device-code CLI: instantiate client, request code, print URL+user_code, poll, persist cache with `0600`, exit | `node src/login.js [profile]` (default `default`) | `auth.js`, `profile-store.js` | Exits non-zero on device-code expiry (15 min), user denial, network error, profile dir unwritable | CLI: exit codes; cache file appears with `0600` after success; no token in stdout |

## Data shapes

```ts
type ProfileId = string; // regex: /^[a-z0-9-]{1,64}$/

interface Profile {
  id: ProfileId;            // 'default' today
  tenant: string;           // 'common' or tenant id
  scopes: string[];         // ['Tasks.ReadWrite', 'Group.Read.All']
  createdAt: string;        // ISO-8601
  lastRefreshAt?: string;   // ISO-8601, absent before first refresh
}

// MSAL token cache: opaque JSON blob the ICachePlugin reads/writes.
// Reference only — do not redefine; let @azure/msal-node own the shape.

interface PlanRow { id: string; title: string; ownerGroupId: string }
interface BucketRow { id: string; name: string; orderHint: string }
interface TaskRow {
  id: string; title: string; bucketId: string;
  dueDateTime?: string;     // ISO-8601
  assignments: string[];    // user ids; Fase 1 always [self]
}
interface TaskDetail extends TaskRow { description?: string } // <= 500 chars unless opt-in

const MAX_DESCRIPTION_CHARS = 500;
const MAX_TITLE_CHARS = 256;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type AuditLine =
  | { event: 'planner_tool_call'; tool: string; profile: ProfileId; result_count: number; duration_ms: number }
  | { event: 'planner_tool_failure'; tool: string; profile: ProfileId; error: string /* constructor name only */ };

const GENERIC_ERROR_TEXT = 'Planner sidecar is unavailable.';
```

## MSAL configuration

Library `@azure/msal-node` (exact version pinned in `sdd-tasks`; Fase 1 only depends on `PublicClientApplication`, `ICachePlugin`, `DeviceCodeRequest`). Config:

```js
{
  auth: {
    clientId: process.env.PLANNER_CLIENT_ID,         // required, app registration in Entra
    authority: `https://login.microsoftonline.com/${process.env.PLANNER_TENANT ?? 'common'}`,
  },
  cache: { cachePlugin: createFileCachePlugin({ profile, stateDir }) },
}
```

`createFileCachePlugin` returns an `ICachePlugin` with `beforeCacheAccess`/`afterCacheAccess` reading and writing `./planner-state/profiles/<id>/token-cache.json` with mode `0600` on first write (`fs.open(path, O_WRONLY|O_CREAT, 0o600)`). `defaultDeviceCodePrompt({verificationUri, userCode})` returns `To sign in, open ${verificationUri} and enter: ${userCode}\n` to stdout (NOT stderr, to keep stderr audit-pure). Silent refresh: `acquireTokenSilent({account, scopes})`; on `InteractionRequiredAuthError` throw `AuthError('refresh-failed')` — `server.js` catches and returns the generic envelope.

## Graph client

Direct `fetch('https://graph.microsoft.com/v1.0/...')` with `Authorization: Bearer <token>` and `Content-Type: application/json`. Endpoints per spec:

| Tool | Endpoint |
|---|---|
| `planner_list_plans` | `GET /me/planner/plans?$select=id,title,ownerGroupId&$top=200` |
| `planner_list_buckets` | `GET /planner/plans/{plan-id}/buckets?$select=id,name,orderHint&$top=200` |
| `planner_list_tasks` | `GET /planner/plans/{plan-id}/tasks?$filter=bucketId eq '{id}'` (optional) `&$filter=dueDateTime lt {date}` etc.; `$top=200`; pagination via `@odata.nextLink` |
| `planner_get_task` | `GET /planner/tasks/{task-id}?$select=id,title,bucketId,dueDateTime,assignments,description` |
| `planner_create_task` | `POST /planner/tasks` with `{ planId, bucketId, title, dueDateTime?, assignments: { '@odata.type': 'microsoft.graph.plannerAssignment', [meId]: { '@odata.type': 'self' } } }`; resolves `me` via `GET /me?$select=id` on first call |
| `planner_status` | Reads `auth.js` last-known `expiresOn`; no Graph call |

On 401: one silent refresh + retry. On 4xx: throw `GraphError({status, code})`. On 5xx: retry with 250ms / 750ms backoff (max 2 attempts), then throw. Never echo Graph body text to MCP — `server.js` catches `GraphError` and returns the generic envelope; the audit log records `error: 'GraphError'` (constructor name only).

## CLI login flow (`src/login.js`)

Args: `[profile]` (default `default`). Steps: read `PLANNER_CLIENT_ID` (fail loud if missing); call `getDeviceCode({scopes: ['Tasks.ReadWrite','Group.Read.All']})`; print `verificationUri` + `userCode` to stdout; poll `acquireTokenByDeviceCode` with 15 min timeout; on success, call `auth.cachePlugin.write(cache)`; `fs.chmodSync(file, 0o600)`; print `Profile '<id>' ready. Token cache at <path>.` to stdout. Non-zero exit codes: `2` missing client id, `3` device-code expired, `4` user denied, `5` network error, `6` profile dir unwritable. `login.js` NEVER calls `fetch` directly and never imports `tools.js` or `server.js`.

## Test strategy

Runner: `node --test test/**/*.test.js`. No Docker, no network. Mocks: `node:fetch` stubbed via a small interceptor; `@azure/msal-node` stubbed via a fake `PublicClientApplication` that records `getDeviceCode`/`acquireTokenSilent` calls and returns canned tokens from `test/fixtures/`. Fixtures: `test/fixtures/{plans,buckets,tasks}.json` (one file per endpoint, minimal valid Graph responses). Coverage rule: every `#### Scenario:` block in `spec.md` becomes at least one `node:test` case written BEFORE the production code in `sdd-apply`. The `TOOL_NAMES` regression test asserts length is 7 AND that the array does not contain `update_task`, `delete_task`, `create_plan`, or `create_bucket`; a second test parses the `planner_create_task` schema JSON and asserts the property `assignee_email` is absent. The `0600` file-mode assertion is unit-testable by stubbing `node:fs/promises` and asserting `mode` arg on `open`; an optional `PLANNER_INTEGRATION=1` path runs `stat` against the real volume after one real `login.js` run and is skipped by default.

## Container and Compose

`Dockerfile`: `FROM node:24-bookworm-slim` (matches IMAP sidecar), `npm ci --omit=dev`, non-root `USER node` (uid 1000 inside the image), `EXPOSE 3000`, `CMD ["node", "src/server.js"]`. Compose service (to be added in `sdd-tasks`, NOT now):

```yaml
planner-sidecar:
  build: ./services/planner-sidecar
  image: planner-sidecar:local
  user: "1000:1000"
  read_only: true
  cap_drop: [ALL]
  no-new-privileges: true
  init: true
  tmpfs: [/tmp:rw,noexec,nosuid,size=64m]
  expose: ["3000"]
  networks: [planner-mcp-internal, planner-egress]
  volumes:
    - ./planner-state:/var/lib/planner-sidecar:ro  # profile/<id>/ subdir needs to be a sibling writable mount in production
  environment:
    PORT: "3000"
    PLANNER_TENANT: "${PLANNER_TENANT:-common}"
    PLANNER_DEFAULT_PROFILE: "default"
  healthcheck:
    test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1))"]
    interval: 30s
    timeout: 5s
    retries: 3
```

No host `ports:`. `planner-egress` is the network ACL; operator restricts to `graph.microsoft.com` + `login.microsoftonline.com` via iptables/egress proxy (out of scope for this Compose block; documented in the operator README). Volume layout note: production deployment must mount `planner-state/profiles` writable and the parent read-only; the `:ro` flag above is a placeholder. `PLANNER_CLIENT_ID` is injected via the operator's secret manager (NOT in `.env`, NOT in `state/openclaw.json`); the sidecar reads it from the process environment.

## OpenClaw integration (apply gate)

Documented diff to `state/openclaw.json`. NOT applied in `sdd-apply` — applied in the final pre-merge gate only after `/healthz` returns `200` and one real device-code login succeeds.

`tools.allow` additions (alphabetical, after `laia-imap__*`):

```json
"planner__planner_create_task",
"planner__planner_get_task",
"planner__planner_list_buckets",
"planner__planner_list_plans",
"planner__planner_list_profiles",
"planner__planner_list_tasks",
"planner__planner_status"
```

`mcp.servers.planner` block (mirrors the `laia-imap` block at `state/openclaw.json:159-180`):

```json
"planner": {
  "url": "http://planner-sidecar:3000/mcp",
  "transport": "streamable-http",
  "connectTimeout": 5,
  "timeout": 30,
  "supportsParallelToolCalls": false,
  "codex": { "agents": ["main"], "defaultToolsApprovalMode": "approve" },
  "toolFilter": { "include": [ /* must equal TOOL_NAMES, see spec */ ] }
}
```

`tools.deny` additions (defense in depth): `planner__planner_update_task`, `planner__planner_delete_task`, `planner__planner_create_plan`, `planner__planner_create_bucket`. These do not exist in Fase 1; the deny block is a regression tripwire per spec `Requirement: OpenClaw Deny Rules`.

## Out-of-scope hooks (Fase 2-6 seams)

Documented here so future phases are purely additive. NONE implemented in Fase 1.

- **Fase 2 `planner_update_task`** — `graph-client.js` already isolates HTTP verb by method; add `updateTask(taskId, patch)` calling `PATCH /planner/tasks/{id}`. Trigger: real "move this card" case.
- **Fase 3 `planner_delete_task`** — Planner soft-delete: `PATCH /planner/tasks/{id} {'@odata.etag': etag, 'isDeleted': true}`. New `getTaskEtag` helper, or fold into `getTask`. Trigger: real "delete this card" case.
- **Fase 4 `planner_create_task.assignee_email`** — Add `assignee_email: z.string().email().optional()` to the create schema; resolve to user id via `GET /users/{email}?$select=id`; build `assignments` map. Regression test for `assignee_email` absence in `TOOL_NAMES` schema is already in place; remove it in Fase 4. Trigger: real "assign to X" case.
- **Fase 5 `planner_create_plan` / `planner_create_bucket`** — `POST /planner/plans` and `POST /planner/buckets`. Adds `Group.ReadWrite.All` scope; new `tools.js` exports. Trigger: real "create a board" case.
- **Fase 6 multi-profile selector** — `auth.js` already keyed by `profile`; today `tools.js` passes `'default'` literally. Lift the literal to a per-request `profile` arg dispatch. Trigger: second profile loaded beyond `default`.

## Migration / Rollout

No migration. New service, additive. Rollback per proposal §Rollback Plan: stop service, revert `state/openclaw.json`, delete `./planner-state/`, redeploy Gateway.

## Open questions

- Exact `@azure/msal-node` version pin: `sdd-tasks` must verify latest stable at implementation time. Fase 1 surface uses only `PublicClientApplication`, `DeviceCodeRequest`, `ICachePlugin` — all stable since 1.x.
- `planner-egress` network ACL: the operator must enforce DNS/IP allowlist for `graph.microsoft.com` and `login.microsoftonline.com` outside Compose (e.g. iptables on the Docker host, or an egress proxy). The Compose file does not encode this; document in the sidecar README.
- Production volume mount layout: `./planner-state` cannot be mounted `:ro` if the sidecar must write the cache. The correct layout is host-dir `planner-state/profiles/<id>` bind-mounted to `/var/lib/planner-sidecar/profiles/<id>` with the parent read-only. `sdd-tasks` must specify the exact bind mount per profile; the example above is a placeholder.
