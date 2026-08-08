# planner-sidecar

Read, self-create, update, delete, and manage MCP sidecar for Microsoft Planner. Ships
thirteen tools across a Streamable HTTP MCP server. Works with any MCP client:
OpenClaw, Claude Desktop, Hermes Agent, etc.

- `planner_list_profiles`, `planner_status`
- `planner_list_plans`, `planner_list_buckets`, `planner_list_tasks`
- `planner_get_task`, `planner_create_task`
- `planner_update_task`, `planner_delete_task`
- `planner_create_plan`, `planner_create_bucket`
- `planner_update_bucket`, `planner_delete_bucket`

Login uses Microsoft device code. The token cache stays local at
`./planner-state/profiles/<profile>/token-cache.json` with mode `0600`.

## Installation

```bash
cd services/planner-sidecar
pnpm install
```

Docker image (for OpenClaw Gateway integration):

```bash
docker compose -f docker-compose2.yml build planner-sidecar
```

## Quick start

```bash
node src/cli.js onboard     # device code login (one-time)
node src/cli.js serve        # starts MCP HTTP server on :3000
```

No Azure App Registration or auth environment variables are required. Open the
verification URL, enter the displayed code, and approve delegated access.

Quick start reference (for docs, demos, or if the package is published to npm):

```bash
npx planner-sidecar onboard
npx planner-sidecar serve
```

## Power user overrides

- `PLANNER_CLIENT_ID`: custom public-client App Registration
- `PLANNER_TENANT`: tenant authority (default: `common`)
- `PLANNER_STATE_DIR`: local state root (default: `./planner-state`)
- `PORT`: MCP HTTP port (default: `3000`)

The built-in registration is multi-tenant, uses
`https://login.microsoftonline.com/common/oauth2/nativeclient`, and requests
`Tasks.ReadWrite` plus `Group.Read.All`. Custom single-tenant registrations must
set both `PLANNER_CLIENT_ID` and `PLANNER_TENANT`.

## Microsoft Graph API Contract

### `GET /v1.0/me/planner/plans`

Endpoint real: `GET /v1.0/me/planner/plans?$select=id,title,owner&$top=200`

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `id` | string | Plan ID (UUID v4-ish, formato Microsoft) |
| `title` | string | Nombre del plan (ej. "Tareas") |
| `owner` | string | **Group ID** del grupo M365 que posee el plan. NO se llama `ownerGroupId`. |

**NO existe** `ownerGroupId` en `microsoft.graph.plannerPlan`. Usar `owner`.

### `GET /planner/plans/{planId}/buckets`

Endpoint: `GET /planner/plans/{planId}/buckets?$select=id,name,orderHint`

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `id` | string | Bucket ID |
| `name` | string | Nombre del bucket (ej. "Hoy") |
| `orderHint` | string | Orden relativo (no usar para mostrar al usuario) |

### `GET /planner/plans/{planId}/tasks`

Endpoint: `GET /planner/plans/{planId}/tasks?$select=id,title,bucketId,dueDateTime,assignments&$top=200`

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `id` | string | Task ID |
| `title` | string | Título de la tarea |
| `bucketId` | string | Bucket al que pertenece |
| `dueDateTime` | string\|null | ISO 8601 datetime |
| `assignments` | object | Mapa de `userId → assignment` |

El campo `assignments` es un objeto cuyas keys son los user IDs asignados. El
user ID de Javier es `22efb16a-2366-4c28-84f2-bb4d874da446`.

### Flujo para obtener IDs

```
planner_list_plans()
  ↓
  plan_id = result[0].id   ← ej. "vPMzhs0pv0eVUaDArQrrvJgAGMpV"
  ↓
planner_list_buckets(plan_id)
  ↓
  bucket_id = result[n].id ← ej. "uu-7r5DKaUWuWMlUIBotRpgAN8HO" (el de "Hoy")
  ↓
planner_list_tasks(plan_id, bucket_id)
  ↓
  task_id = result[n].id   ← ej. "uBbWS7Ef10qs23cbBs_aEZgANOH5"
  ↓
planner_get_task(task_id)
```

Los IDs de Microsoft Planner NO son UUIDs. Son strings opacos en formato
Microsoft (base64-like, 32-38 chars). Ejemplos reales:

- Plan ID: `vPMzhs0pv0eVUaDArQrrvJgAGMpV`
- Bucket ID: `uu-7r5DKaUWuWMlUIBotRpgAN8HO`
- Task ID: `elevRA8ZnUO7Q7gpiRxS-pgADXAS`

El schema de las tools acepta `z.string().min(1).max(512)`. Pasarlos textuales.

Algunos modelos (StepFlash / step-3.7-flash) rechazan estos IDs por "no ser
UUIDs" a pesar de que el schema y la descripción de la tool digan lo contrario.
DeepSeek y GPT no tienen este problema. Solución: cambiar la descripción de la
tool MCP para que diga "opaque Microsoft Planner identifier string" sin
mencionar UUIDs, o cambiar el modelo.

## Tool Inventory

| Tool | Notes |
| --- | --- |
| `planner_list_profiles` | Returns loaded profile ids (Fase 1: solo `"default"`) |
| `planner_status` | Reports `{connected, expiresAt}` sin exponer el token |
| `planner_list_plans` | Returns plan rows con `id`, `title`, `owner` (Group ID) |
| `planner_list_buckets` | Returns bucket rows para un plan (ID opaco, no UUID) |
| `planner_list_tasks` | Returns tasks con filtros opcionales de bucket, fecha, assignee |
| `planner_get_task` | Trunca description a 500 chars por defecto |
| `planner_create_task` | Siempre self-assigns al usuario autenticado (Javier) |
| `planner_update_task` | Modifica percentComplete, dueDate, bucketId o title. Requiere etag de Graph. |
| `planner_delete_task` | Requiere `confirm: true`. El agente debe preguntar antes de llamar. |
| `planner_create_plan` | Crea un plan nuevo. Requiere un groupId existente. |
| `planner_create_bucket` | Crea un bucket nuevo dentro de un plan. |
| `planner_update_bucket` | Renombra un bucket existente. Requiere etag de Graph. |
| `planner_delete_bucket` | Requiere `confirm: true`. El agente debe preguntar antes de llamar. |

## Security Boundary

Allowed:

- `GET /healthz`
- Read + self-create Planner tools above
- MSAL device-code login via CLI
- Profile cache only under `./planner-state/profiles/<profile>/token-cache.json`

Forbidden:

- `assignee_email` on `planner_create_task` (self-assign only)
- App-only tokens or client credentials
- Token strings in stderr, `.env`, Compose, `state/openclaw.json`, workspace, or Engram

## OpenClaw Gateway Configuration

For OpenClaw Gateway, register the sidecar in `state/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "planner": {
        "transport": "streamable-http",
        "url": "http://planner-sidecar:3000/mcp",
        "toolFilter": {
          "include": [
            "planner_list_profiles",
            "planner_status",
            "planner_list_plans",
            "planner_list_buckets",
            "planner_list_tasks",
            "planner_get_task",
            "planner_create_task",
            "planner_update_task",
            "planner_delete_task",
            "planner_create_plan",
            "planner_create_bucket",
            "planner_update_bucket",
            "planner_delete_bucket"
          ]
        }
      }
    }
  },
  "tools": {
    "allow": [
      "planner__planner_list_profiles",
      "planner__planner_status",
      "planner__planner_list_plans",
      "planner__planner_list_buckets",
      "planner__planner_list_tasks",
      "planner__planner_get_task",
      "planner__planner_create_task",
      "planner__planner_update_task",
      "planner__planner_delete_task",
      "planner__planner_create_plan",
      "planner__planner_create_bucket",
      "planner__planner_update_bucket",
      "planner__planner_delete_bucket"
    ]
  }
}
```

For Telegram-direct access, add the same 13 tools to
`channels.telegram.direct.<userId>.tools.allow`.

Other MCP clients (Claude Desktop, Cline, etc.) only need the URL:

```json
{
  "mcpServers": {
    "planner": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```
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

Docker Compose (`docker-compose2.yml`):

- `planner-sidecar` en networks: `planner-mcp-internal`, `planner-egress`
- Gateway (`openclaw-gateway`) en networks incluye `planner-mcp-internal` para
  resolver `planner-sidecar` por DNS.

## Live Data (usuario: Javier — electronautica)

| Concepto | Valor |
| --- | --- |
| User ID | `22efb16a-2366-4c28-84f2-bb4d874da446` |
| Plan único | "Tareas" — ID `vPMzhs0pv0eVUaDArQrrvJgAGMpV` |
| Owner del plan | Group ID `b8179882-88e2-4bc5-93f5-a8f07d94dbb1` |
| Buckets | "Hoy" (`uu-7r5DKaUWuWMlUIBotRpgAN8HO`), "Esta semana" (`kFKVLbiNTE-j_dh8e6qKc5gAEthh`), "Próxima semana" (`64Ez6SLAwEi55z8xvnwCNpgAH-Wz`), "Sin pausa pero sin prisa" (`UwbUWVZEnkeYNO3g1FA_VpgAAYbt`), "Trabajos en activo" (`m35bskdx60mNJ79vlyTsOJgAEtNx`) |
| Total tareas | ~33-41 (vivas, sin contar completadas) |
| Asignadas a Javier | ~13 tareas (la mayoría en "Esta semana" y "Hoy") |

## Bugfix History

### ownerGroupId → owner (2026-07-25)

`listPlans()` en `graph-client.js` hacía select de `ownerGroupId`, que NO
existe en `microsoft.graph.plannerPlan`. La API devolvía 400. Fix:
`select: 'id,title,owner'`.

### import.meta.url guard (2026-07-25)

`login.js` comparaba `process.argv[1]` con `import.meta.url`. El problema es que
`process.argv[1]` es una ruta relativa (ej. `src/login.js`) mientras que
`import.meta.url` es absoluta con protocolo `file://`. Fix: usar
`path.resolve(process.argv[1])` + `fileURLToPath(import.meta.url)`.

### MCP closeTransport (2026-07-25)

`server.js` permitía un solo `initialize` por conexión. Si el cliente reconectaba
y enviaba un segundo `initialize` (ej. Gateway lazy connect), fallaba con
"Already connected to a transport". Fix: llamar `closeTransport()` antes de
`connectTransport()` en el handler de `initialize`.

### MCP tool descriptions: UUID framing (2026-07-25)

StepFlash (step-3.7-flash) rechazaba IDs no-UUID tipo `vPMzhs0pv0eVUaDArQrrvJgAGMpV`
aunque el schema de la tool aceptara `z.string().min(1).max(512)` sin formato UUID.
El modelo aplicaba su propia validación de formato al ver el ID devuelto por
`planner_list_plans` y nunca llamaba `planner_list_tasks`.

Fix: cambiar las descriptions de las tools MCP de "NOT a UUID" (que mantenía el
concepto UUID en el contexto) a "opaque Microsoft Planner identifier string".
DeepSeek y GPT no tienen este problema — solo StepFlash.

### Gateway network (2026-07-25)

El Gateway no podía resolver el hostname `planner-sidecar` por DNS porque no
estaba en la red `planner-mcp-internal`. Fix: agregar `planner-mcp-internal` a
la lista `networks` del servicio `openclaw-gateway` en `docker-compose2.yml`.

### planner_update_task / planner_delete_task — If-Match etag (2026-07-25)

Graph API requires `If-Match: {etag}` header for PATCH and DELETE on tasks. The
etag (`@odata.etag`) is obtained by doing a GET on the task first.

- `updateTask` y `deleteTask` en `graph-client.js` hacen GET con `select: 'id,@odata.etag,percentComplete'`, extraen el etag, y lo pasan como header.
- `request()` acepta `headers` extra para pasar `If-Match`.
- `planner_delete_task` tiene `confirm: literal(true)` en el schema para evitar borrados accidentales.
- El agente DEBE preguntar a Javier antes de llamar `planner_delete_task`.

### planner_update_bucket / planner_delete_bucket — bucket tools (2026-07-27)

Same If-Match etag pattern as task tools. Graph API requires `If-Match: {etag}`
for PATCH and DELETE on buckets too.

- `updateBucket` y `deleteBucket` en `graph-client.js` hacen GET con `select: 'id,@odata.etag,name'`, extraen el etag, y lo pasan como header.
- `planner_delete_bucket` tiene `confirm: literal(true)` en el schema — el agente DEBE preguntar antes de borrar.
- `planner_create_bucket` y `planner_create_plan` no requieren If-Match (creación POST).
- `deleteBucket` cascade rule: Microsoft Planner does NOT cascade-delete tasks when the bucket is deleted — Graph returns a 400 if the bucket has live tasks. The agent must move or delete tasks first.

## Non-Goals (future work)

- Multi-profile selector beyond `default`
- Comments, attachments, checklists, external references
- App-only tokens (device code only)
- Assign to third parties (`assignee_email`)

## Troubleshooting

### Planner tools devuelven "Planner sidecar is unavailable."

Causa posible: error en la llamada a Graph API. Revisar logs del sidecar:

```bash
docker compose logs planner-sidecar
```

Buscar `planner_tool_failure` — el log incluye el nombre del error
(`GraphError`, etc.). Para más detalle, agregar temporalmente el error message
al log.

### Login fails with an AADSTS error

The built-in registration needs no auth environment variables. If you use a
custom registration, verify `PLANNER_CLIENT_ID`; custom single-tenant apps must
also set `PLANNER_TENANT` to their tenant ID. Then rerun:

```bash
node src/cli.js onboard
```

### Token cache root-owned

Si `planner-state/` fue creado por Docker volume, puede ser `root`. Recrear:

```bash
sudo chown -R 1000:1000 planner-state/
```

### MCP initialize falla con "Already connected to a transport"

Ocurre cuando el Gateway reconecta. El fix está en `server.js`:
`closeTransport()` antes de `connectTransport()`. Si sigue pasando, verificar
que el fix esté deployado (reconstruir el container).

### Gateway no resuelve planner-sidecar

```bash
docker compose exec openclaw-gateway curl -s http://planner-sidecar:3000/healthz
```

Si falla, verificar que `openclaw-gateway` tenga `planner-mcp-internal` en su
lista de networks en `docker-compose2.yml`.

### Re-login después de expiración del token

El token cache tiene un `expiresAt` timestamp. Cuando expira, MSAL refresca
automáticamente si hay refresh token. Si falla, run:

```bash
node src/cli.js onboard
```

y completar el device code flow.

## Sources

- Proposal guardada en engram: `planner-sidecar/fase-1`
- Reference sidecar: `services/laia-imap-sidecar/`

## VPS Migration Reminder

Future VPS cutover details stay in `docs/internal/vps-migration.md`. This repo
does not automate that migration here.
