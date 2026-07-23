# planner-sidecar (Fase 1 — PR 1 skeleton)

Read + self-create MCP sidecar for Microsoft Planner, modeled on
`services/laia-imap-sidecar/`. Stays strictly within Fase 1: 7 narrow
read + self-create tools against Microsoft Graph Planner, MSAL device-code
login via CLI, audit log to stderr, hardened container, generic error
envelope. No update / delete / assign-a-terceros / create-plan /
create-bucket surface.

This is PR 1 of the chained Fase 1 rollout. Only `/healthz` is implemented
here; the Fase 1 surface lands across PRs 2-5 and OpenClaw wiring lands in
PR 6.

## Quick Path (placeholder — finalized in PR 5)

```bash
docker compose build planner-sidecar
docker compose up -d planner-sidecar
docker compose exec planner-sidecar \
  node -e "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1))"
```

## Login

Use the device-code CLI to seed the per-profile MSAL cache:

```bash
node src/login.js default
```

The CLI opens the Microsoft device login flow, prints the verification URL
and code, then stores the token cache at
`./planner-state/profiles/<profile>/token-cache.json` with mode `0600`.

## Security Boundary (placeholder — finalized in PR 5)

| Allowed                                                                     | Forbidden                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /healthz` returning `200 ok` (liveness only)                           | Update, delete, assign-a-terceros, create-plan, create-bucket tools                       |
| Containerized read + self-create via MSAL device code                       | App-only tokens, client credentials, org-wide admin scope                                 |
| Token cache at `./planner-state/profiles/<id>/token-cache.json` mode `0600` | Tokens in `.env`, Compose, `state/openclaw.json`, workspace, Gateway, CLI, Engram, stderr |
| Internal Compose network only; no host port                                 | Host port publish, public ingress, raw shell                                              |

## Runtime Architecture (placeholder — finalized in PR 5)

| Surface         | Value                                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| Compose service | `planner-sidecar` (image `planner-sidecar:local`)                                   |
| Build context   | `./services/planner-sidecar`                                                        |
| User            | `1000:1000`, `read_only`, `cap_drop: ALL`, `no-new-privileges`                      |
| Health          | `GET /healthz` → `200 ok`                                                           |
| Port            | Internal only, no host publish                                                      |
| Mounts          | `./planner-state:/var/lib/planner-sidecar` (Fase 1 default)                         |
| Env             | `PLANNER_CLIENT_ID` (required), `PLANNER_TENANT`, `PLANNER_DEFAULT_PROFILE`, `PORT` |

## Tool Inventory and Redaction (finalized in PR 4)

Lands in PR 4 when `src/tools.js` is implemented. Until then, the sidecar
serves only `GET /healthz`.

## Non-Goals

- `planner_update_task`, `planner_delete_task`, `planner_create_plan`,
  `planner_create_bucket` — all out of scope for Fase 1. Each ships
  only when a real case arrives (per
  `openspec/changes/planner-sidecar/proposal.md` §Roadmap).
- `assignee_email` on `planner_create_task`. The Fase 1 create tool
  always self-assigns to the authenticated user.
- Multi-profile real selector. The `profile?` arg is accepted on every
  tool but ignored; the effective profile is `default`.
- Reading attachments, comments, checklists, external references.
- Reusing `extensions/msteams/` Graph code or any Codex Apps for Planner.
- Editing `docker-compose.yml`, the Gateway, or other sidecars.

## Sources

- OpenSpec proposal: `openspec/changes/planner-sidecar/proposal.md`
- OpenSpec spec: `openspec/changes/planner-sidecar/spec.md`
- OpenSpec design: `openspec/changes/planner-sidecar/design.md`
- OpenSpec tasks: `openspec/changes/planner-sidecar/tasks.md`
- Operator proposal: `docs/internal/planner-sidecar-proposal.md`
- Reference sidecar: `services/laia-imap-sidecar/`
- Engram anchors: `planner-sidecar/fase-1` (#2395),
  `sidecar/security-pattern` (#2396), `sdd-init/openclaw` (#2397)
