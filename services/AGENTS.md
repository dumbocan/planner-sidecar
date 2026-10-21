# AGENTS.md — `services/`

Scoped rules for every sidecar under `services/` and for the config that wires
them into the gateway. Read this before touching a sidecar, its Dockerfile, or
`state/openclaw.json`.

Each rule below exists because breaking it already caused a real outage or a
silent failure. Follow the rule; do not "simplify" around it.

## Never

- **Never edit source and expect it live.** Compose builds these images from
  `./services/<name>` with **no source bind mount**. Editing a file changes
  nothing until you rebuild the image *and* recreate the container. A whole day
  was lost to a container running a two-day-old image.
- **Never trust a green test suite as proof of deployment.** Tests run on the
  host; the gateway talks to the container.
- **Never merge a read bundle and a write bundle into one MCP server.** Pairs
  like `m365-calendar` / `m365-calendar-writes` and `planner` /
  `planner-writes` exist to keep different approval modes (`approve` vs `auto`)
  against the same sidecar URL. Merging them silently removes that separation.
- **Never give an MCP sidecar a single shared `McpServer` transport.** Two
  bundles booting against one URL is the supported shape, so every sidecar must
  create **one `McpServer` per session**. The shared-registry + `currentTransport`
  + `close()` pattern makes the second `initialize` kill the first session; the
  gateway then reports `Error POSTing to endpoint: [redacted response body]` and
  the tools vanish from the agent catalog. See "Required session pattern".
- **Never add `codex.agents` to widen or narrow exposure by guesswork.** That
  block is Codex app-server projection metadata only. `codex.agents: ["main"]`
  already matches this deployment's single agent (`main`, identity Laia), so it
  is not the reason a write tool is missing. Check `openclaw agents list` first.
- **Never remove `toolFilter.include` entries to "fix" a missing tool.** The
  filter is the allowlist. A missing tool means the MCP server failed to start,
  not that the filter is too tight.
- **Never commit or "clean up" `state/openclaw.json`.** It is gitignored on
  purpose and holds credentials and operator wiring.
- **Never touch `*/secrets`, `*-secrets/`, `.env`, or token/key JSON files.**
  Never print their contents, and never paste tokens into chat or logs.
- **Never restart the operator's gateway.** It is their running instance. Use
  `openclaw mcp reload` and `openclaw mcp probe` inside the container instead.
- **Never run `docker compose down`, prune, or touch another service's volumes**
  to fix one sidecar. Recreate only the service you changed, with
  `docker compose -f docker-compose2.yml up -d --no-deps <service>`.
- **Never weaken a read-only contract** to make a tool work: no
  `getMailboxLock` without `{ readOnly: true }`, no relaxed TLS, no raised
  `maxLiteralSize`, no new write/send/move/delete capability in a read sidecar.
- **Never make mailbox validation accept arbitrary names.** A path is valid only
  if a fresh `LIST` reports it selectable. When the user's name differs from the
  server's (`Sent` vs `INBOX.Sent`), add bounded alias resolution with ambiguity
  refusal — do not loosen the check.
- **Never treat the generic error envelope as "the service is down".** Sidecars
  collapse failures into one sentence on purpose. Read the container logs for the
  real `message` field before diagnosing.
- **Never change OAuth scopes casually.** Per-slot scope intent lives in each
  sidecar README; a slot documented as read-only must not gain a read-write
  scope.
- **Never ship a Dockerfile that needs a lockfile the repo does not have.** The
  planner image could not be rebuilt for this exact reason; the build fails with
  `"/pnpm-lock.yaml": not found` and `docker compose up` then silently keeps the
  old image.

## Required session pattern (MCP sidecars)

```js
export function createApp(runtime = createRuntime()) {
  // Per app instance: two gateway bundles hit this same endpoint.
  const sessions = new Map();

  return createServer(async (request, response) => {
    // ...
    if (!sessionId && body?.method === "initialize") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      // One McpServer per session: a shared registry must close the previous
      // connection on every initialize, which drops the peer bundle.
      const sessionServer = createMcpServer(runtime);
      await sessionServer.connect(transport);
      return transport.handleRequest(request, response, body);
    }
    // ...
  });
}
```

Every sidecar with more than one bundle (or that may get one) carries the
regression test `two concurrent MCP sessions stay usable at the same time`.
Keep it: it fails with the old shared-registry code (`HTTP 404`, empty body).

## Deploy discipline

1. `cd services/<name> && node --test test/*.test.js` — green, and record the
   baseline failures you did not cause.
2. `docker compose -f docker-compose2.yml build <service>` — **read the output**.
   A failed build does not stop `up`, which then reuses the stale image.
3. `docker compose -f docker-compose2.yml up -d --no-deps <service>`.
4. `docker ps` → `healthy`.
5. `docker exec openclaw-openclaw-gateway-1 openclaw mcp reload`.
6. `docker exec openclaw-openclaw-gateway-1 openclaw mcp probe` → every bundle
   lists its tools and nothing reports `failed to start server`.
7. Spot-check one real call through the sidecar's own `/mcp` endpoint.

## Diagnosing a sidecar

- Container healthy ≠ working. `openclaw mcp probe` is the fastest truth for
  "does the gateway see this sidecar's tools".
- `docker logs --tail 20 openclaw-<service>-1` for the real failure message.
- Probe `/mcp` directly (initialize + `tools/list` + one `tools/call`) to
  separate "sidecar broken" from "gateway wiring broken".
- Intermittent tool availability across two bundles pointing at one URL is the
  single-session defect, not a race in the gateway.

## Adding a new sidecar

- Follow an existing sidecar's shape: `Dockerfile`, `package.json`, `src/`,
  `test/`, `README.md` with its tool inventory and privacy rules.
- Include a lockfile that matches the Dockerfile's package manager.
- Keep the container `read_only: true`, `cap_drop: ALL`,
  `no-new-privileges:true`, no published port, and secrets mounted read-only.
- Register one bundle per approval mode, never one bundle for everything.
- Add the tools to the gateway allowlist only when the operator authorizes it.
- Document what the sidecar must never do in its own README.
