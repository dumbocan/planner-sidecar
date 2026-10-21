# m365-calendar-sidecar

Read, create, update, and delete Microsoft 365 Calendar events through an MCP
Streamable HTTP server. Ships eight tools:

- `calendar_list_profiles`, `calendar_status`
- `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`
- `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`

Login uses Microsoft device code. The token cache stays local at
`./calendar-state/profiles/<profile>/token-cache.json` with mode `0600`.

## Installation

```bash
cd services/m365-calendar-sidecar
npm install
```

Docker image (for OpenClaw Gateway integration):

```bash
docker compose -f docker-compose2.yml build m365-calendar-sidecar
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
npx m365-calendar-sidecar onboard
npx m365-calendar-sidecar serve
```

## Power user overrides

- `M365_CALENDAR_CLIENT_ID`: custom public-client App Registration
- `M365_CALENDAR_TENANT`: tenant authority (default: `common`)
- `M365_CALENDAR_STATE_DIR`: local state root (default: `./calendar-state`)
- `PORT`: MCP HTTP port (default: `3000`)

The built-in registration is the same multi-tenant app used by the planner
sidecar: `https://login.microsoftonline.com/common/oauth2/nativeclient`. The
Graph delegated scopes are `Calendars.ReadWrite` for this sidecar and
`Tasks.ReadWrite, Group.Read.All` for the planner sidecar. Tenant admins can
grant the bundled app both scopes, or operators can set `M365_CALENDAR_CLIENT_ID`
to a custom registration that requests `Calendars.ReadWrite` from their tenant.

## Microsoft Graph API Contract

### `GET /v1.0/me/calendars`

Endpoint: `GET /v1.0/me/calendars?$select=id,name,isDefaultCalendar&$top=200`

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Calendar ID (opaque Microsoft identifier) |
| `name` | string | Calendar name (e.g. "Calendar") |
| `isDefaultCalendar` | boolean | True if this is the user's default calendar |

### `GET /me/calendarView`

Endpoint: `GET /me/calendarView?startDateTime=...&endDateTime=...&$select=...&$top=200`

The `calendarView` endpoint returns expanded event occurrences for the given
date range. `startDateTime` and `endDateTime` are ISO 8601 strings. The range
end is exclusive on the next day boundary.

### `GET /me/calendars/{calendarId}/calendarView`

Same as `calendarView`, but scoped to one specific calendar.

### `GET /me/events/{eventId}`

Returns a single event with full body, attendees, and the `@odata.etag` field
required for PATCH/DELETE.

### `POST /me/events`

Creates an event. Body fields include `subject`, `start`/`end` (`{dateTime, timeZone}`),
`body` (`{contentType, content}`), `location` (`{displayName}`), `attendees`,
`isOnlineMeeting`, `reminderMinutesBeforeStart`, `categories`.

### `PATCH /me/events/{eventId}` with `If-Match: "<etag>"`

Updates an event. The etag is obtained from a prior GET.

### `DELETE /me/events/{eventId}` with `If-Match: "<etag>"`

Deletes an event. The etag is obtained from a prior GET.

### Calendar IDs and event IDs

Calendar IDs and event IDs are opaque Microsoft identifier strings (NOT UUIDs).
Pass them verbatim from `calendar_list_calendars` / `calendar_list_events`.

## Tool Inventory

| Tool | Notes |
| --- | --- |
| `calendar_list_profiles` | Returns loaded profile ids (default: `["default"]`) |
| `calendar_status` | Reports `{connected, expiresAt}` without exposing the token |
| `calendar_list_calendars` | Returns calendar rows with `id`, `name`, `is_default` |
| `calendar_list_events` | Lists events with date range filtering (max 365 days). Optional `calendar_id`. |
| `calendar_get_event` | Returns a single event with normalized fields. Optional `calendar_id` for non-default calendars. |
| `calendar_create_event` | Creates an event; ISO 8601 times via `time_zone` (UTC default). Optional `calendar_id`. |
| `calendar_update_event` | Updates an event. Requires `confirm: true` literal. Uses If-Match etag. Optional `calendar_id`. Partial date/time pairs rejected. At least one field required. |
| `calendar_delete_event` | Deletes an event. Requires `confirm: true` literal. Agent MUST ask user before calling. Optional `calendar_id` for non-default calendars. |

## Security Boundary

Allowed:

- `GET /healthz`
- Read + write calendar tools above
- MSAL device-code login via CLI
- Profile cache only under `./calendar-state/profiles/<profile>/token-cache.json`

Forbidden:

- Bulk read of all calendars (`calendarView` requires explicit date range)
- App-only tokens or client credentials
- Token strings in stderr, `.env`, Compose, `state/openclaw.json`, workspace, or Engram
- Email addresses in user-facing responses (organizer/attendees only expose display name + count)

## Agent Usage Guide

These rules apply to every calendar tool call. They prevent the most common
agent-side failures reported against this sidecar (silent no-ops, wrong
calendar, leaked attendee emails, rejected PATCH/DELETE).

### Always obtain `calendar_id` from `calendar_list_calendars`

Calendar identifiers are opaque Microsoft strings, not UUIDs and not user
emails. Never invent one, never reuse a calendar display name, never assume the
default calendar is what the user means. The only safe source is:

```json
{ "tool": "calendar_list_calendars" }
```

The response is `[{ "id": "…", "name": "…", "is_default": true|false }, …]`.
Pass `id` back into the other tools verbatim — do not normalise it.

### Pass `calendar_id` to every non-default calendar operation

For any calendar other than the user's default, include `calendar_id` on the
get / update / delete call so Microsoft Graph routes to
`/me/calendars/{calendarId}/events/{eventId}` instead of the default
`/me/events/{eventId}`. Without `calendar_id` you will silently hit the wrong
calendar or a 404. With `calendar_id` you stay on the calendar the user
actually asked about.

### Use `event_id` verbatim, never construct one

`event_id` comes back from `calendar_list_events` or `calendar_get_event`. It is
opaque and Microsoft-assigned. Do not derive it from a subject, a date, or a
row index.

### Always send `confirm: true` for update and delete

`calendar_update_event` and `calendar_delete_event` require the literal
`confirm: true` (not `"true"`, not `1`, not `yes`). Without it the call is
rejected with `confirm must be true …`. For delete you must also ask the user
for an explicit yes/no before calling — the sidecar will delete, Microsoft will
not ask again.

### Provide complete date + time pairs for any time change

`start_date` and `start_time` must travel together; the same for `end_date` and
`end_time`. Partial pairs are rejected so a stray `start_date` cannot silently
skip a date change. To move an event, supply all four fields explicitly.

### Specify `time_zone` explicitly when it matters

The default time zone is UTC. If the user gives a wall-clock time without a
time zone, the sidecar sends it as UTC and the event lands at the wrong local
hour. For any European, American, or other named zone, set `time_zone` (for
example `Europe/Madrid`, `America/New_York`). Microsoft Graph accepts IANA
names.

### No sensitive data is returned

The sidecar never echoes back attendee or organiser email addresses — only
display names plus counts are exposed when relevant. If you need a sanitised
view of attendees, present them as `Alice (and 3 others)`, never as the raw
addresses.

### Update body must include at least one field

Calling `calendar_update_event` with only `confirm: true` and nothing else is
rejected because it would PATCH an empty body. Always include at least one of:
`subject`, the paired `start_date`+`start_time`, the paired `end_date`+
`end_time`, `time_zone`, `location`, `body`, `attendees`, `is_online_meeting`,
`reminder_minutes_before_start`, `categories`.

### Working example

```json
{
  "tool": "calendar_list_calendars"
}
```

```json
{
  "tool": "calendar_update_event",
  "args": {
    "calendar_id": "AAMkAGI2TGuLAAA=",
    "event_id": "AAMkAGI2TGuLAAA0BAAA=",
    "confirm": true,
    "subject": "Quarterly review",
    "start_date": "2026-08-21",
    "start_time": "15:00",
    "end_date": "2026-08-21",
    "end_time": "16:00",
    "time_zone": "Europe/Madrid"
  }
}
```

## OpenClaw Gateway Configuration

For OpenClaw Gateway, register the sidecar in `state/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "m365-calendar": {
        "transport": "streamable-http",
        "url": "http://m365-calendar-sidecar:3000/mcp",
        "toolFilter": {
          "include": [
            "calendar_list_profiles",
            "calendar_status",
            "calendar_list_calendars",
            "calendar_list_events",
            "calendar_get_event",
            "calendar_create_event",
            "calendar_update_event",
            "calendar_delete_event"
          ]
        }
      }
    }
  },
  "tools": {
    "allow": [
      "m365-calendar__calendar_list_profiles",
      "m365-calendar__calendar_status",
      "m365-calendar__calendar_list_calendars",
      "m365-calendar__calendar_list_events",
      "m365-calendar__calendar_get_event",
      "m365-calendar__calendar_create_event",
      "m365-calendar__calendar_update_event",
      "m365-calendar__calendar_delete_event"
    ]
  }
}
```

For Telegram-direct access, add the same 8 tools to
`channels.telegram.direct.<userId>.tools.allow`.

Other MCP clients (Claude Desktop, Cline, etc.) only need the URL:

```json
{
  "mcpServers": {
    "m365-calendar": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Container security

| Surface | Value |
| --- | --- |
| Compose service | `m365-calendar-sidecar` |
| Build context | `./services/m365-calendar-sidecar` |
| User | `1000:1000` |
| `read_only` | `true` |
| `cap_drop` | `ALL` |
| `security_opt` | `no-new-privileges:true` |
| Health | `GET /healthz` → `200 ok` |
| Port | `3000` internal only |
| Mounts | `./calendar-state:/var/lib/m365-calendar` |

Docker Compose (`docker-compose2.yml`):

- `m365-calendar-sidecar` on networks: `calendar-mcp-internal`, `calendar-egress`
- Gateway (`openclaw-gateway`) on networks includes `calendar-mcp-internal` so
  it can resolve `m365-calendar-sidecar` by DNS.

## Onboarding (production)

```bash
docker compose run --rm m365-calendar-sidecar onboard
```

This drives the MSAL device-code flow once and writes the token cache to
`./calendar-state/profiles/default/token-cache.json` with mode `0600`. The default
container user is `1000:1000`, so the host directory must be owned by that
UID/GID before first run:

```bash
mkdir -p calendar-state
sudo chown 1000:1000 calendar-state
```

## Sources

- `services/planner-sidecar/` — structural reference (modulo Graph scope).
- `services/laia-imap-sidecar/` — secondary reference for MSAL contract.
- Microsoft Graph API reference: `https://learn.microsoft.com/en-us/graph/api/resources/calendar`
