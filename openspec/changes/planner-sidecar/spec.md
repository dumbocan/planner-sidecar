# Specification: Planner Sidecar (Fase 1)

## Capability Delta

### New Capabilities

- `mcp-planner-tools` — the 7-tool MCP surface for read + self-create against Microsoft Graph Planner. `profile?` arg is accepted but ignored today (default `default`); the hook ships so Fase 6 can promote it to a real dispatcher without breaking the surface.

### Modified Capabilities

- None. `openspec/specs/` does not yet exist for this repo. This is the first OpenSpec change.

### Removed Capabilities

- None.

## Purpose

Defines the contract for the `services/planner-sidecar/` Streamable HTTP MCP server: seven narrow read + self-create tools against Microsoft Graph Planner, MSAL device-code login via CLI, audit log to stderr, and a hardened container. Stays strictly within Fase 1 — no update/delete/assign-a-terceros/create-plan/create-bucket surface. Anchored by Engram `planner-sidecar/fase-1` (#2395) and `sidecar/security-pattern` (#2396).

## Requirements

### Requirement: planner_list_profiles

The system MUST expose `planner_list_profiles` returning the set of profiles currently loaded, with no other fields.

#### Scenario: Returns the single default profile

- GIVEN the sidecar is healthy
- WHEN `planner_list_profiles` is called
- THEN it returns exactly `{profiles: ["default"]}` with no other fields

### Requirement: planner_status

The system MUST expose `planner_status` reporting connection state without exposing token content.

#### Scenario: Reports connected with expiry when MSAL cache is fresh

- GIVEN the `default` token cache exists with `expiresOn` in the future
- WHEN `planner_status` is called
- THEN it returns `{connected: true, expiresAt: <ISO-8601>}` and the response contains no token string

### Requirement: planner_list_plans

The system MUST expose `planner_list_plans` returning one row per plan owned by the authenticated user, with only `id`, `title`, and `ownerGroupId`.

#### Scenario: Returns sanitized plan rows

- GIVEN Graph returns N plans
- WHEN `planner_list_plans` is called
- THEN it returns `[{id, title, ownerGroupId}]` and never includes description, members, or raw metadata

### Requirement: planner_list_buckets

The system MUST expose `planner_list_buckets` accepting a UUID `plan_id` and returning ordered bucket rows.

#### Scenario: Returns ordered buckets for a valid plan and rejects non-UUID ids

- GIVEN a valid UUID `plan_id`
- WHEN `planner_list_buckets` is called
- THEN it returns `[{id, name, orderHint}]` in Graph order
- AND IF `plan_id` is not a valid UUID, zod fails and the MCP returns the generic envelope

### Requirement: planner_list_tasks

The system MUST expose `planner_list_tasks` with strict zod validation on every input.

#### Scenario: Filters by date range and assignee

- GIVEN valid UUID `plan_id`, `due_before=2026-12-31`, `due_after=2026-01-01`, `assigned_to_me=true`
- WHEN `planner_list_tasks` is called
- THEN it returns `[{id, title, dueDateTime?, bucketId, assignments}]` with no description field

#### Scenario: Rejects malformed dates and non-UUID ids

- GIVEN `due_before="not-a-date"` or `plan_id="abc"`
- WHEN `planner_list_tasks` is called
- THEN zod fails and the MCP returns the generic envelope; no Graph call is made

### Requirement: planner_get_task

The system MUST expose `planner_get_task` with description truncated to 500 chars by default and full only on explicit `include_full_description: true`.

#### Scenario: Truncates description by default

- GIVEN a valid UUID `task_id` and a Graph task whose `description` is 1200 chars
- WHEN `planner_get_task` is called without `include_full_description`
- THEN the returned `description` is at most 500 chars and stderr records the success event

#### Scenario: Returns full description only on explicit opt-in

- GIVEN the same task and `include_full_description: true`
- WHEN `planner_get_task` is called
- THEN the returned `description` is the full Graph string and stderr records the opt-in

### Requirement: planner_create_task

The system MUST expose `planner_create_task` creating a task always self-assigned to the authenticated user, with strict zod validation on every input.

#### Scenario: Creates a task with valid input and self-assigns

- GIVEN valid UUID `plan_id`, valid UUID `bucket_id`, `title` 1..256 chars, optional `due_date="2026-08-01"`
- WHEN `planner_create_task` is called
- THEN it returns `{id, title, bucketId, dueDateTime?}` and the new task is assigned to the authenticated user only

#### Scenario: Rejects oversize title, bad UUID, or bad date

- GIVEN `title` of 257 chars, non-UUID `plan_id`, or `due_date="2026/08/01"`
- WHEN `planner_create_task` is called
- THEN zod fails and the MCP returns the generic envelope; no Graph call is made

### Requirement: Auth Expiry and MSAL Refresh

The system MUST silently refresh the access token via MSAL on expiry and surface the generic envelope only when refresh fails.

#### Scenario: Silent refresh on near-expiry access token

- GIVEN the `default` profile's access token is within the MSAL refresh window
- WHEN any tool is called
- THEN MSAL refreshes transparently, the tool succeeds, and stderr records the success event with no token string

#### Scenario: Refresh failure surfaces as the generic envelope

- GIVEN MSAL refresh fails (revoked, missing cache, removed profile dir)
- WHEN any tool is called
- THEN the tool returns `Planner sidecar is unavailable.` and stderr records the failure event with the error constructor name only

### Requirement: Profile Arg Behavior in Fase 1

The system MUST accept a `profile?: string` argument on every tool, ignore it, and use `default` as the effective profile in Fase 1.

#### Scenario: Any profile arg is ignored

- GIVEN `profile="secretaria"` is passed to `planner_list_plans`
- WHEN the tool runs
- THEN the audit log records `profile: 'default'`, not `secretaria`, and the result is the default user's plans

### Requirement: Generic Error Envelope

The system MUST return the exact string `Planner sidecar is unavailable.` on every caught tool error and MUST NOT leak the error message, stack, IDs, paths, or content.

#### Scenario: Every caught error returns the same opaque envelope

- GIVEN any tool is invoked and any error is thrown after zod validation
- WHEN `server.js` catches the error
- THEN the MCP response is exactly `Planner sidecar is unavailable.` and stderr records the failure event with the error constructor name only

## Security Requirements

### Requirement: Graph Delegated Permission Scope

The system MUST request only `Tasks.ReadWrite` and `Group.Read.All` as delegated Graph permissions. No app-only token, no client credentials, no org-wide admin scope.

#### Scenario: Permission set is the documented minimum

- GIVEN the `auth.js` configuration and the consent screen in the device-code flow
- WHEN the operator consents
- THEN the requested scopes are exactly `Tasks.ReadWrite` and `Group.Read.All`, and `auth.js` rejects any other scope set at startup

### Requirement: Token Isolation

The system MUST persist the MSAL token cache only at `./planner-state/profiles/<id>/token-cache.json` with mode `0600` and owner `1000:1000`. Tokens MUST NOT appear in `.env`, Compose files, `state/openclaw.json`, the workspace, the Gateway, the CLI, Engram, or stderr.

#### Scenario: Token cache file mode and owner

- GIVEN the operator ran `node src/login.js default` successfully
- WHEN `stat` reads `./planner-state/profiles/default/token-cache.json`
- THEN the mode is `0600` and the owner is `1000:1000`

#### Scenario: Token string never appears in disallowed sinks

- GIVEN any tool is called successfully and any tool fails
- WHEN the process captures stderr, the workspace, `.env`, Compose, `state/openclaw.json`, and Engram
- THEN none of those sinks contain the bearer token or any substring of it

### Requirement: Audit Log Shape

The system MUST emit a single JSON object to stderr per tool invocation. The shape is `{event: 'planner_tool_call'|'planner_tool_failure', tool, profile, result_count?, duration_ms?, error?: <constructor_name>}`. The system MUST NOT log titles, descriptions, task IDs, due dates, error messages, or token strings.

#### Scenario: Every call emits one structured line with no content

- GIVEN any tool call completes (success or failure)
- WHEN stderr is captured
- THEN exactly one JSON line is emitted matching the documented shape, with no extra fields and no task content

### Requirement: Container Hardening

The system MUST run as a hardened Compose service: `user: "1000:1000"`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges: true`, `init: true`, `tmpfs: /tmp:rw,noexec,nosuid,size=64m`, no host port mapping, internal-only network, and `/healthz` returning `200`.

#### Scenario: Healthcheck returns 200 on the internal network

- GIVEN the container is up and reachable at `http://planner-sidecar:3000/healthz` from `planner-mcp-internal`
- WHEN a `GET /healthz` is issued
- THEN the response is `200 ok` and no other port is published to the host

### Requirement: Tool Surface Regression Guard

The system MUST export a single `TOOL_NAMES` constant containing exactly the seven Fase 1 tool names. The test suite MUST fail if `TOOL_NAMES` ever includes `update_task`, `delete_task`, `create_plan`, or `create_bucket`, or if the `planner_create_task` zod schema ever adds `assignee_email`.

#### Scenario: Adding an update or delete tool fails the build

- GIVEN a code change that adds `planner_update_task` or `planner_delete_task` to `TOOL_NAMES`
- WHEN `node --test test/**/*.test.js` is run
- THEN the regression test fails and the change is rejected

#### Scenario: Adding `assignee_email` to the create schema fails the build

- GIVEN a code change that adds `assignee_email` to the `planner_create_task` zod schema
- WHEN `node --test test/**/*.test.js` is run
- THEN the regression test fails and the change is rejected

### Requirement: OpenClaw Deny Rules

The OpenClaw gateway MUST deny the non-Fase-1 tool names `planner__planner_update_task`, `planner__planner_delete_task`, `planner__planner_create_plan`, and `planner__planner_create_bucket` as defense in depth. The `tools.allow` allowlist is the primary boundary; deny rules are belt-and-suspenders.

#### Scenario: Deny rule rejects a non-Fase-1 tool call

- GIVEN the deny rules are present in `state/openclaw.json`
- WHEN a tool call for `planner__planner_update_task` is dispatched
- THEN the gateway rejects it before reaching the sidecar and emits the standard deny audit event

## Acceptance Criteria

Each criterion is objectively testable and maps 1:1 to the proposal's Acceptance Checklist.

- `node --test test/**/*.test.js` exits `0` with no network and no Docker.
- `TOOL_NAMES` exports exactly seven strings and contains none of `update_task`, `delete_task`, `create_plan`, `create_bucket`.
- A regression test fails the build if `TOOL_NAMES` is extended with any of those names or if `planner_create_task` schema adds `assignee_email`.
- `server.js` returns the exact string `Planner sidecar is unavailable.` on every caught tool error and never logs a token, title, description, task ID, due date, or error message.
- `docker compose build planner-sidecar` exits `0`.
- `docker compose up -d planner-sidecar` brings the container to a healthy state and `GET /healthz` returns `200`.
- `state/openclaw.json` `tools.allow` lists the seven `planner__*` names in canonical alphabetical order and `mcp.servers.planner` block is present with `toolFilter.include` matching `TOOL_NAMES`.
- `state/openclaw.json` `tools.deny` lists `planner__planner_update_task`, `planner__planner_delete_task`, `planner__planner_create_plan`, and `planner__planner_create_bucket`.
- The token cache file `./planner-state/profiles/default/token-cache.json` exists with mode `0600` and owner `1000:1000` after one successful device-code login.
- `.gitignore` excludes `/planner-state/` and `/.env.planner`.
- The container runs as `1000:1000` with `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, and `init`; no host port is published.
- A grep over stderr captures, `.env`, Compose, `state/openclaw.json`, workspace, and Engram contains no token string or task content.
- README documents Quick Path, Security Boundary, Runtime Architecture, Tool Inventory, and Non-Goals.

## TDD Contract

Per `~/.pi/agent/skills/test-driven-development/SKILL.md`, every `#### Scenario:` block above becomes a failing `node:test` spec written BEFORE implementation. The `sdd-apply` phase MUST:

1. Read this spec.
2. Write failing `node:test` specs under `services/planner-sidecar/test/sidecar.test.js` that cover every scenario.
3. Confirm `node --test test/**/*.test.js` reports red (failing tests).
4. Implement only until every test is green.
5. Refactor with green tests as the safety net.

No prod-only commits. No skipping scenarios because they look redundant. Each scenario is a real test, not a comment.

## Out of Scope

Each phase ships only when its trigger case arrives in production. Engram `planner-sidecar/fase-1` (#2395) records this discipline.

- **Fase 2 — `planner_update_task`**: rename, move bucket, change due date. Trigger: a real "move this card" case from the operator.
- **Fase 3 — `planner_delete_task`**: delete own tasks only, explicit confirm. Trigger: a real "delete this card" case.
- **Fase 4 — `planner_create_task.assignee_email`**: assign to third parties, validated against Graph. Trigger: a real "assign to X" case.
- **Fase 5 — `planner_create_plan` and `planner_create_bucket`**: create boards. Trigger: a real "create a board" case.
- **Fase 6 — Multi-profile selector**: real per-request `profile` dispatch. Trigger: a second profile loaded beyond `default`.
