import path from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_SCOPES, createAuthClient } from "./auth.js";
import { tryOpenBrowser } from "./browser-open.js";
import { createTerminalReadLine, persistClientId, resolveClientId } from "./setup.js";

// Resolves the client ID and persists it under the sidecar state directory.
// Always interactive: prompts unless OUTLOOK_CLIENT_ID is set explicitly,
// and writes the validated value to <stateDir>/client-id.txt with mode 0600.
//
// `persistImpl` and `resolveImpl` are injected for tests.
export async function runSetup({
  stateDir = process.env.OUTLOOK_STATE_DIR ?? "./outlook-state",
  envClientId = process.env.OUTLOOK_CLIENT_ID,
  isInteractive = Boolean(process.stdin?.isTTY),
  readLine,
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  resolveImpl = resolveClientId,
  persistImpl = persistClientId,
} = {}) {
  const resolved = await resolveImpl({
    envClientId,
    stateDir,
    isInteractive,
    readLine,
    stderr,
  });
  if (resolved.source === "env") {
    stdout(`Using OUTLOOK_CLIENT_ID from the environment.`);
    stdout(
      "It is not persisted to disk. Run `npm run setup` in an interactive shell to save it locally instead.",
    );
    return { clientId: resolved.clientId, source: resolved.source, file: null };
  }
  if (resolved.source === "file") {
    stdout(`Using the client ID stored at ${path.join(stateDir, "client-id.txt")}.`);
    return {
      clientId: resolved.clientId,
      source: resolved.source,
      file: path.join(stateDir, "client-id.txt"),
    };
  }
  const persisted = await persistImpl({ stateDir, clientId: resolved.clientId });
  stdout(`Saved client ID to ${persisted.file} (mode 0600).`);
  stdout("Next step: run `npm run onboard` to complete the Microsoft sign-in.");
  stderr(JSON.stringify({ event: "outlook_setup_success", file: persisted.file }));
  return { clientId: resolved.clientId, source: "prompt", file: persisted.file };
}

export async function runOnboarding({
  clientId = process.env.OUTLOOK_CLIENT_ID,
  stateDir = process.env.OUTLOOK_STATE_DIR ?? "./outlook-state",
  PublicClientApplicationImpl,
  isInteractive = Boolean(process.stdin?.isTTY),
  readLine,
  openImpl = tryOpenBrowser,
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  resolveImpl = resolveClientId,
} = {}) {
  const resolved = await resolveImpl({
    envClientId: clientId,
    stateDir,
    isInteractive,
    readLine,
    stderr,
  });
  const client = await createAuthClient({
    clientId: resolved.clientId,
    stateDir,
    PublicClientApplicationImpl,
  });
  try {
    let browserOpened = false;
    const result = await client.acquireTokenByDeviceCode({
      scopes: GRAPH_SCOPES,
      deviceCodeCallback: (response) => {
        // MSAL's `message` is the human-readable instruction and contains the
        // verification URL plus user code. Always echo it so the operator has
        // a fallback even if the browser launch below fails.
        stdout(response.message);
        // Only open URLs that MSAL itself returned. `verificationUri` is the
        // single allowed source; never substitute a URL from any other input.
        const verificationUri =
          typeof response?.verificationUri === "string" ? response.verificationUri : null;
        if (!browserOpened && verificationUri) {
          browserOpened = true;
          openImpl(verificationUri).then((outcome) => {
            if (!outcome.opened) {
              stderr(
                JSON.stringify({
                  event: "outlook_browser_open_failed",
                  error: outcome.error,
                }),
              );
              stderr(
                "Browser auto-open failed. Open the URL above manually and enter the code to continue.",
              );
            }
          });
        }
      },
    });
    void result;
    stdout("Outlook authentication completed. The token cache is stored with mode 0600.");
    stdout(
      "Next steps: start the sidecar, attach the outlook-mail MCP server, and expose only its four read-only tools to the isolated agent.",
    );
    stderr(JSON.stringify({ event: "outlook_onboarding_success" }));
    return { authenticated: true };
  } catch (error) {
    stderr(
      JSON.stringify({
        event: "outlook_onboarding_failure",
        error: error?.constructor?.name ?? "Error",
      }),
    );
    throw new Error("Outlook authentication failed", { cause: error });
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("Usage: outlook-mail-sidecar <setup|onboard>");
  }
  const command = argv[0];
  if (command === "setup" || command === "onboard") {
    return { command };
  }
  throw new Error("Usage: outlook-mail-sidecar <setup|onboard>");
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.command === "setup") {
    const readLine = createTerminalReadLine();
    try {
      await runSetup({ readLine });
    } catch {
      process.exitCode = 1;
    } finally {
      try {
        readLine.close();
      } catch {
        // Best-effort close; failure to close the readline interface must not
        // mask a setup failure.
      }
    }
    return;
  }
  if (parsed.command === "onboard") {
    const readLine = process.stdin?.isTTY ? createTerminalReadLine() : undefined;
    try {
      await runOnboarding({ readLine });
    } catch {
      process.exitCode = 1;
    } finally {
      try {
        readLine?.close();
      } catch {
        // Best-effort close.
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
