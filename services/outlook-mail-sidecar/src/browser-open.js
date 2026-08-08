import { spawn } from "node:child_process";

// Resolves the platform-appropriate opener executable without shell
// interpolation. The URL is always passed as a positional argv entry, never as
// part of a shell string, so a hostile URL (e.g. one that contains
// `; rm -rf ~`) cannot break out of the command.
//
// Returns the resolved opener definition. Callers can override this for
// tests; production code uses process.platform.
export function resolveOpener({ platform = process.platform } = {}) {
  if (platform === "darwin") {
    return { command: "open", argsPrefix: [] };
  }
  if (platform === "win32") {
    return { command: "cmd", argsPrefix: ["/c", "start", '""'] };
  }
  return { command: "xdg-open", argsPrefix: [] };
}

// Attempts to launch the given URL in the operator's browser.
//
// The caller MUST only pass URLs that originate from MSAL's device-code
// callback. This function never inspects the URL itself; the contract is
// enforced by the caller (cli.js) which extracts `verificationUri` directly
// from the MSAL response object.
//
// `spawnImpl` defaults to `node:child_process.spawn`. Tests inject a stub that
// simulates `spawn` succeeding, erroring, or timing out without spawning a
// real process.
//
// Resolves to:
//   { opened: true,  error: null }      on successful launch
//   { opened: false, error: <string> }  on failure (caller falls back to the
//                                       displayed URL/code from the device-code
//                                       callback message)
export async function tryOpenBrowser(url, options = {}) {
  const { spawnImpl = spawn, platform = process.platform, timeoutMs = 5000 } = options;
  if (typeof url !== "string" || url.length === 0) {
    return { opened: false, error: "no_url" };
  }
  const { command, argsPrefix } = resolveOpener({ platform });
  const args = [...argsPrefix, url];

  let child;
  try {
    child = spawnImpl(command, args, {
      shell: false,
      stdio: "ignore",
      detached: true,
    });
  } catch (error) {
    return { opened: false, error: error?.code ?? "spawn_error" };
  }
  if (!child || typeof child.pid !== "number" || child.pid <= 0) {
    return { opened: false, error: "spawn_failed" };
  }
  // Detach so the opener can outlive the sidecar process; the user keeps
  // control of the browser even if the onboarding script exits early.
  try {
    child.unref();
  } catch {
    // unref is best-effort; a missing unref is not a launch failure.
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (opened, error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ opened, error });
    };
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      finish(false, err?.code ?? "spawn_error");
    });
    // 'spawn' fires when the OS process is created. On Linux, xdg-open exec's
    // and exits fast, so we also accept 'exit' as proof of successful launch.
    child.once("spawn", () => {
      clearTimeout(timer);
      finish(true, null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0 || code === null, code === 0 ? null : `exit_${code}`);
    });
  });
}
