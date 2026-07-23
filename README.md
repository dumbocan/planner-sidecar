# planner-sidecar (Fase 1)

Read + self-create MCP sidecar for Microsoft Planner, modeled on
`services/laia-imap-sidecar/`. Fase 1 ships exactly seven tools:

- `planner_list_profiles`
- `planner_status`
- `planner_list_plans`
- `planner_list_buckets`
- `planner_list_tasks`
- `planner_get_task`
- `planner_create_task`

Login is device-code only (`node src/login.js default`). The token cache lives
at `./planner-state/profiles/<profile>/token-cache.json` and must stay mode
`0600`.

## Quick Path

```bash
docker compose build planner-sidecar
docker compose up -d planner-sidecar
node src/login.js default
```

## Security Boundary

Allowed:

- `GET /healthz`
- Read + self-create Planner tools above
- MSAL device-code login via CLI
- Profile cache only under `./planner-state/profiles/<profile>/token-cache.json`

Forbidden:

- Update/delete/create-plan/create-bucket tools
- `assignee_email` on `planner_create_task`
- App-only tokens or client credentials
- Token strings in stderr, `.env`, Compose, `state/openclaw.json`, workspace, or Engram

## Runtime Architecture

| Surface | Value |
| --- | --- |
| Compose service | `planner-sidecar` |
| Build context | `./services/planner-sidecar` |
| User | `1000:1000` |
| Health | `GET /healthz` → `200 ok` |
| Port | `3000` internal only |
| Mounts | `./planner-state:/app/planner-state` |

## Tool Inventory

| Tool | Notes |
| --- | --- |
| `planner_list_profiles` | Returns loaded profile ids |
| `planner_status` | Reports cache freshness without exposing token content |
| `planner_list_plans` | Returns plan rows with `id`, `title`, `ownerGroupId` |
| `planner_list_buckets` | Returns bucket rows for a UUID plan |
| `planner_list_tasks` | Returns tasks with bounded date/assignee filtering |
| `planner_get_task` | Truncates description to 500 chars by default |
| `planner_create_task` | Always self-assigns to the authenticated user |

## Non-Goals

- `planner_update_task`
- `planner_delete_task`
- `planner_create_plan`
- `planner_create_bucket`
- Real multi-profile selector in Fase 1
- Comments, attachments, checklists, external references

## Sources

- OpenSpec proposal: `openspec/changes/planner-sidecar/proposal.md`
- OpenSpec spec: `openspec/changes/planner-sidecar/spec.md`
- OpenSpec design: `openspec/changes/planner-sidecar/design.md`
- OpenSpec tasks: `openspec/changes/planner-sidecar/tasks.md`
- Reference sidecar: `services/laia-imap-sidecar/`

## Troubleshooting

- Missing `PLANNER_CLIENT_ID` causes tool calls to fail, but the healthcheck
  still responds `200`.
- If login fails, rerun `node src/login.js default` and complete the device
  code flow again.

## VPS Migration Reminder

Future VPS cutover details stay in `docs/internal/vps-migration.md`. This repo
does not automate that migration here.
