# Tasks: Planner Sidecar (Fase 1)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2070 (src 960 + tests 800 + README 250 + config 60, excl. `package-lock.json`) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 skeleton+health · PR2 profile+auth+login · PR3 graph-client · PR4 tools+wiring · PR5 hardening+README · PR6 wiring+smoke (deferred) |
| Delivery strategy | ask-always |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main|feature-branch-chain|size-exception|pending
400-line budget risk: High

### Work Units

| Unit | Goal | PR | Test cmd | Harness | Rollback |
|------|------|----|----------|---------|----------|
| 1 | Skeleton+health | PR1 | `node --test test/server.test.js` | `curl /healthz` | `services/planner-sidecar/{Dockerfile,package.json,src/server.js}` |
| 2 | profile-store | PR2 | `node --test test/profile-store.test.js` | N/A unit | `src/profile-store.js` |
| 3 | auth+login | PR2 | `node --test test/{auth,login}.test.js` | manual login | `src/{auth,login}.js` |
| 4 | graph-client | PR3 | `node --test test/graph-client.test.js` | N/A mock | `src/graph-client.js` |
| 5 | tools read | PR4 | `node --test test/tools.test.js` | N/A | `src/tools.js` read subset |
| 6 | create+wiring | PR4 | `node --test test/server.test.js` | `curl POST /mcp` | `src/{tools,server}.js` |
| 7 | hardening+README | PR5 | `node --test test/sidecar.test.js` | `docker compose up` | `Dockerfile`, `README.md` |
| 8 | wiring+smoke | PR6 | N/A manual | end-to-end | `state/openclaw.json`, `docker-compose.yml`, `.gitignore` |

## Phase 1: Skeleton + Health (PR 1)

- [x] 1.1 RED: `test/server.test.js` asserts `GET /healthz` returns `200 ok`. Run — FAIL. (Captured `ERR_MODULE_NOT_FOUND` for `../src/server.js`.)
- [x] 1.2 GREEN: Add `services/planner-sidecar/{package.json, package-lock.json, Dockerfile, .env.example, .gitignore, README.md, src/server.js, test/server.test.js}` with minimal `/healthz` only. 3/3 tests pass; runtime `curl /healthz` → 200, `/anything` → 404, `POST /healthz` → 404. (`McpServer` + `/mcp` land in PR 4.)

## Phase 2: profile-store (PR 2)

- [x] 2.1 RED: `test/profile-store.test.js` for `validateProfileId` (reject `..`, uppercase, `/`, empty, > 64), `listProfiles`, `profileDir`. Run — FAIL.
- [x] 2.2 GREEN: Implement `src/profile-store.js`. Run — PASS.

## Phase 3: auth + login CLI (PR 2)

- [x] 3.1 RED: `test/auth.test.js` for `ICachePlugin.open(mode 0o600)`, `acquireTokenSilent` (cached vs refresh vs `InteractionRequiredAuthError`). Run — FAIL.
- [x] 3.2 GREEN: Implement `src/auth.js` (`createAuthClient`, `createFileCachePlugin`). Run — PASS.
- [x] 3.3 RED: `test/login.test.js` for argv parse, exit codes 2/3/4/5/6, stdout URL+code, cache `0600`. Run — FAIL.
- [x] 3.4 GREEN: Implement `src/login.js` device-code CLI. Run — PASS.

## Phase 4: graph-client (PR 3)

- [x] 4.1 RED: `test/graph-client.test.js` for URL shapes (`$select`, `$top=200`), 401→refresh+retry, 4xx→`GraphError`, 5xx→2 retries, never echo body. Run — FAIL.
- [x] 4.2 GREEN: Implement `src/graph-client.js` raw `fetch` + bearer + error mapping. Run — PASS.

## Phase 5: tools.js Read Tools (PR 4)

- [x] 5.1 RED: `test/tools.test.js` covers 6 read scenarios + `TOOL_NAMES` regression (length 7; no update/delete/create_plan/create_bucket; no `assignee_email`). Run — FAIL.
- [x] 5.2 GREEN: Implement `src/tools.js` with `TOOL_NAMES`, zod, sanitization (`description.slice(0, 500)`), audit dispatch, profile-arg-ignored. Run — PASS.

## Phase 6: Create Tool + Server Wiring (PR 4)

- [x] 6.1 RED: Tests for `planner_create_task` (self-assign; reject 257-char title, non-UUID, bad date), `server.js` 405 on non-POST/GET/DELETE, generic envelope. Run — FAIL.
- [x] 6.2 GREEN: Add create tool to `src/tools.js`; register all 7 in `src/server.js`; catch returns exact `Planner sidecar is unavailable.`. Run — PASS.

## Phase 7: Audit + Hardening + README (PR 5)

- [x] 7.1 RED: Tests for audit shape, token absence, Dockerfile `USER node`/`EXPOSE 3000`, mcp-error envelope. Run — FAIL.
- [x] 7.2 GREEN: Wire stderr-only audit; finalize `Dockerfile`; create `README.md` (Quick Path, Security Boundary, Runtime Architecture, Tool Inventory, Non-Goals, Sources, Troubleshooting, VPS Migration Reminder). Run — PASS.

## Phase 8: OpenClaw Wiring + Smoke (PR 6, deferred)

- [ ] 8.1 GATE: Operator runs `docker compose build && up -d planner-sidecar && node src/login.js default`, completes device-code, then OpenCode calls `planner_list_profiles` and `planner_create_task`. STOP if any fails.
- [ ] 8.2 Apply `state/openclaw.json` allowlist (7 `planner__*`, alphabetical), `mcp.servers.planner` block (`toolFilter.include = TOOL_NAMES`), deny rules.
- [ ] 8.3 Apply `docker-compose.yml` `planner-sidecar:` service (user 1000:1000, read_only, cap_drop ALL, no-new-privileges, init, tmpfs, internal networks, no `ports:`, healthcheck).
- [ ] 8.4 Add `/planner-state/`, `/.env.planner` to `.gitignore`.
- [ ] 8.5 Operator runs Acceptance Checklist (12 items) from `docs/internal/planner-sidecar-proposal.md` and Acceptance Criteria (12 items) in `spec.md`. Block merge until all green.

## TDD Discipline + Runner + Out-of-Scope

Per `~/.pi/agent/skills/test-driven-development/SKILL.md`, `sdd-apply` MUST for every RED/GREEN pair: (1) failing test, (2) `node --test` RED, (3) minimal impl, (4) GREEN, (5) refactor only with green tests. No prod-only commits. `TOOL_NAMES` and `assignee_email` regression tests are non-negotiable.

`strict_tdd: true`. Runner: `node --test test/**/*.test.js`. Mocks: `@azure/msal-node` fake `PublicClientApplication`; `node:fetch` interceptor; fixtures in `test/fixtures/`. `0600` mode unit-testable via `node:fs/promises` stub; `PLANNER_INTEGRATION=1` off by default.

Reject any `sdd-apply` proposal adding `planner_update_task`, `planner_delete_task`, `planner_create_plan`, `planner_create_bucket`, `assignee_email` on `planner_create_task`, or a real multi-profile selector. Fase 2-6 ship only when their trigger case arrives (Engram `#2395`, `#2396`).
