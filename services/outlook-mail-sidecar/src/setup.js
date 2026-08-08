import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout as stdoutStream } from "node:process";
import { createInterface } from "node:readline/promises";

// Standard Microsoft Entra app registration client ID format:
// eight hex groups separated by dashes in the canonical 8-4-4-4-12 layout.
export const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLIENT_ID_PROMPT_LABEL = "Application (client) ID";

export function isValidClientId(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length !== 36) {
    return false;
  }
  return CLIENT_ID_PATTERN.test(trimmed);
}

export function clientIdFilePath(stateDir) {
  return path.join(path.resolve(stateDir ?? "./outlook-state"), "client-id.txt");
}

export async function loadStoredClientId({ stateDir } = {}) {
  const file = clientIdFilePath(stateDir);
  try {
    const contents = await readFile(file, "utf8");
    const trimmed = contents.trim();
    if (isValidClientId(trimmed)) {
      return trimmed;
    }
    return null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function persistClientId({
  stateDir,
  clientId,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  chmodImpl = chmod,
} = {}) {
  if (!isValidClientId(clientId)) {
    throw new Error("OUTLOOK_CLIENT_ID is not a valid Microsoft application client ID");
  }
  const trimmed = clientId.trim();
  const resolved = path.resolve(stateDir ?? "./outlook-state");
  await mkdirImpl(resolved, { recursive: true });
  // mkdir's mode is a hint modified by umask; chmod explicitly to enforce the
  // restrictive permission the sidecar requires.
  await chmodImpl(resolved, 0o700);
  const file = clientIdFilePath(resolved);
  await writeFileImpl(file, `${trimmed}\n`, { mode: 0o600 });
  await chmodImpl(file, 0o600);
  return { stateDir: resolved, file };
}

export function resolveClientIdFromEnv(env = process.env) {
  const raw = env?.OUTLOOK_CLIENT_ID;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!isValidClientId(trimmed)) {
    throw new Error("OUTLOOK_CLIENT_ID is not a valid Microsoft application client ID");
  }
  return trimmed;
}

// `node:readline/promises` returns the answer directly from question(). An
// interface closed by EOF rejects instead, which we normalize for the caller.
async function readLineOnce({ readLine }) {
  try {
    return await readLine.question(`${CLIENT_ID_PROMPT_LABEL}: `);
  } catch {
    return null;
  }
}

// Prompts the operator for a client ID and re-asks until a valid UUID is
// entered. The function never persists the value; persistClientId is the
// canonical owner of disk side-effects.
//
// `readLine` must expose the promise-returning question(prompt) API from
// node:readline/promises. Tests inject a compatible fake to avoid real stdin.
// Tests inject a fake to avoid real stdin.
export async function promptForClientId({
  readLine,
  stderr = (line) => process.stderr.write(`${line}\n`),
  isInteractive = true,
} = {}) {
  if (!isInteractive) {
    throw new Error(
      "OUTLOOK_CLIENT_ID is required; pass it via OUTLOOK_CLIENT_ID or run the sidecar interactively",
    );
  }
  if (!readLine || typeof readLine.question !== "function") {
    throw new Error("promptForClientId requires a readline interface");
  }
  while (true) {
    const raw = await readLineOnce({ readLine });
    if (raw === null) {
      throw new Error("OUTLOOK_CLIENT_ID is required; no client ID was supplied (stdin closed)");
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      stderr(
        "A client ID is required. Paste the Application (client) ID from the app registration.",
      );
      continue;
    }
    if (!isValidClientId(trimmed)) {
      stderr(
        "That is not a valid Microsoft application client ID. Expected the 8-4-4-4-12 UUID shown in the Entra app overview.",
      );
      continue;
    }
    return trimmed;
  }
}

// Resolves the client ID for an interactive onboarding session. Order:
//   1. OUTLOOK_CLIENT_ID environment variable (noninteractive source of truth)
//   2. Persisted file at <stateDir>/client-id.txt
//   3. Interactive prompt (only if isInteractive is true)
//   4. Throw — no source available
//
// The persisted value is read but never re-prompted; setup.js treats the file
// as the operator's recorded answer, not a hint.
export async function resolveClientId({
  envClientId,
  stateDir,
  isInteractive = false,
  readLine,
  stderr = (line) => process.stderr.write(`${line}\n`),
  env = process.env,
  loadImpl = loadStoredClientId,
  promptImpl = promptForClientId,
} = {}) {
  const fromEnv =
    typeof envClientId === "string" && envClientId.trim()
      ? envClientId.trim()
      : resolveClientIdFromEnv(env);
  if (fromEnv) {
    if (!isValidClientId(fromEnv)) {
      throw new Error("OUTLOOK_CLIENT_ID is not a valid Microsoft application client ID");
    }
    return { clientId: fromEnv, source: "env" };
  }
  const stored = await loadImpl({ stateDir });
  if (stored) {
    return { clientId: stored, source: "file" };
  }
  if (!isInteractive) {
    throw new Error(
      "OUTLOOK_CLIENT_ID is required; set the environment variable, store it with `npm run setup`, or run interactively",
    );
  }
  const prompted = await promptImpl({ readLine, stderr, isInteractive: true });
  return { clientId: prompted, source: "prompt" };
}

// Convenience factory for a readline interface tied to stdin/stdout. Tests
// inject their own; production callers use this to drive an interactive
// terminal session.
export function createTerminalReadLine({ input = stdin, output = stdoutStream } = {}) {
  return createInterface({ input, output, terminal: true });
}
