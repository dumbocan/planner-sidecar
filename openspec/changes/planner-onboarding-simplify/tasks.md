# Tasks: planner-onboarding-simplify

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~250 (auth.js -10/+8, login.js -5/+2, server.js -40/+4, cli.js new ~55, package.json +3, README.md ~50 restr, .env.example ~6, tests +140) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | single-pr |
| Chain strategy | size-exception (not needed; under budget) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | BUILTIN_CLIENT_ID + auth resolution chain | Single PR | `node --test services/planner-sidecar/test/auth.test.js` | `node src/cli.js onboard` (mock MSAL) | Revert single commit; old `clientId` guards return |
| 2 | CLI dispatcher + package bin + docs | Same PR | `node --test services/planner-sidecar/test/cli.test.js` | `node src/cli.js --help` then `serve` | Revert cli.js + package.json `bin`; `node src/server.js` still works |

Pre-0 precondition: confirm the maintainer-owned multi-tenant App Registration client ID exists and capture the GUID. Do not commit a placeholder. Block apply if missing.

## Phase 1: Auth foundation (auth.js)

- [ ] 1.1 RED: add `test/auth.test.js` cases asserting `createAuthClient` resolves `clientId` precedence — constructor arg > non-empty `PLANNER_CLIENT_ID` env > `BUILTIN_CLIENT_ID`; empty env string does not mask built-in.
- [ ] 1.2 RED: add test asserting `tenant` defaults to `'common'` when neither arg nor `PLANNER_TENANT` set; constructor arg wins over env.
- [ ] 1.3 GREEN: in `src/auth.js`, export `BUILTIN_CLIENT_ID` constant near auth constants; change the `state.clientId` line in `createAuthClient` to apply precedence with empty-string guard.
- [ ] 1.4 GREEN: remove the production `if (!clientId) throw new AuthError(...)` in `buildClient`; keep the test-injection path via `PublicClientApplicationImpl`.

## Phase 2: Remove hard guards

- [ ] 2.1 RED: add `test/login.test.js` case asserting `runLogin` does not throw when no `clientId` arg and no `PLANNER_CLIENT_ID` env; resolves to `BUILTIN_CLIENT_ID`.
- [ ] 2.2 GREEN: in `src/login.js`, delete the `if (!clientId) { console.error(...); process.exit(2); }` block at the direct-entry guard; let `runLogin` resolve defaults; update exit-code comment.
- [ ] 2.3 RED: add `test/server.test.js` case asserting `createRuntime` constructs real `auth` and `graph` clients when no `PLANNER_CLIENT_ID` env is set; no `PLANNER_CLIENT_ID is required` error from any tool.
- [ ] 2.4 GREEN: in `src/server.js`, remove the `clientId ? createAuthClient(...) : stub` and `clientId ? createGraphClient(...) : stub` branches in `createRuntime`; always pass `clientId` through; default env reading stays unchanged.

## Phase 3: CLI dispatcher (new)

- [ ] 3.1 RED: create `test/cli.test.js` asserting `parseCliArgs(['onboard'])` → `{ command: 'onboard', profile: 'default' }`; `['onboard','work']` → `{ command: 'onboard', profile: 'work' }`; `['serve']` → `{ command: 'serve' }`; `['--help']` → `{ command: 'help' }`; `['--version']` → version present; `[]` and `['nope']` → `{ command: 'help', unknown: true }`.
- [ ] 3.2 GREEN: create `src/cli.js` with shebang, `parseCliArgs`, usage text, and `main(argv)` that resolves `stateDir` from `PLANNER_STATE_DIR` else `./planner-state`, ensures dir with `mkdir({ recursive: true, mode: 0o700 })`, then dispatches `onboard` → `runLogin`, `serve` → `listen`, help → print+exit 0, unknown → stderr+exit 2.
- [ ] 3.3 RED: add test asserting `main` creates state dir when missing and honors existing dir when present; verifies mode 0700 on creation.
- [ ] 3.4 GREEN: in `main`, wrap `serve` startup in `try/catch` mapping errors to `exit 1`; onboard failures reuse existing `runLogin` exit codes.

## Phase 4: Package + docs

- [ ] 4.1 in `package.json`, bump `version` to `0.2.0`; add `"bin": { "planner": "src/cli.js" }`; add `"files": ["src", "README.md", ".env.example"]`; keep `start` script and `Dockerfile` entry unchanged.
- [ ] 4.2 in `README.md`, replace Setup sections with quick start (`docker compose up -d planner-sidecar` + `docker compose exec planner-sidecar planner onboard`); add ≤10-line "Power user" subsection documenting `PLANNER_CLIENT_ID`/`PLANNER_TENANT`/`PLANNER_STATE_DIR`/`PORT` overrides; keep Graph API contract and tool inventory intact.
- [ ] 4.3 in `.env.example`, mark `PLANNER_CLIENT_ID=` as optional override; add `PLANNER_STATE_DIR=` override; document defaults inline.

## Phase 5: Verification

- [ ] 5.1 run `node --test services/planner-sidecar/test/**/*.test.js` — all pass (existing + new).
- [ ] 5.2 run `node src/cli.js --help` and `node src/cli.js --version` from repo root — exit 0, no token in stdout/stderr.
- [ ] 5.3 confirm `node src/server.js` still starts the MCP server (Docker CMD parity).
- [ ] 5.4 confirm `git diff --check` is clean on all touched files.
