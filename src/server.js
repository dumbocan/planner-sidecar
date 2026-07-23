import { createServer } from "node:http";

const DEFAULT_PORT = 3000;

// Fase 1 (PR 1) only serves `/healthz`. The full MCP transport on `/mcp` lands
// in PR 4 alongside the seven planner_* tools. Today the only contract is a
// shallow liveness probe: a 200 on `GET /healthz`, 404 on anything else.
function healthzHandler(request, response) {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200).end("ok");
    return;
  }
  response.writeHead(404).end();
}

export function createApp() {
  return createServer(healthzHandler);
}

export function listen(port = Number(process.env.PORT ?? DEFAULT_PORT)) {
  return new Promise((resolve, reject) => {
    const server = createApp();
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "0.0.0.0");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listen().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
