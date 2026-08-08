import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLIENT_ID_PATTERN,
  clientIdFilePath,
  isValidClientId,
  loadStoredClientId,
  persistClientId,
  promptForClientId,
  resolveClientId,
  resolveClientIdFromEnv,
} from "../src/setup.js";

const VALID_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const ANOTHER_VALID_CLIENT_ID = "abcdef01-2345-6789-abcd-ef0123456789";

function fakeReadLine(answers) {
  // answers is an array of strings returned in order. After the array is
  // exhausted the interface behaves like readline/promises after EOF.
  const queue = answers.slice();
  return {
    question() {
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(new Error("readline closed"));
      }
      return Promise.resolve(next);
    },
  };
}

function captureStderr() {
  const lines = [];
  return {
    lines,
    write(line) {
      lines.push(line);
    },
  };
}

test("isValidClientId accepts the canonical Microsoft Entra UUID shape only", () => {
  assert.equal(isValidClientId(VALID_CLIENT_ID), true);
  assert.equal(isValidClientId(VALID_CLIENT_ID.toUpperCase()), true);
  assert.equal(isValidClientId("11111111-2222-3333-4444-55555555555"), false, "too short");
  assert.equal(isValidClientId("11111111-2222-3333-4444-5555555555555"), false, "too long");
  assert.equal(isValidClientId("11111111-2222-3333-4444-55555555555Z"), false, "non-hex char");
  assert.equal(isValidClientId("111111112-222-333-444-55555555555"), false, "wrong group sizes");
  assert.equal(isValidClientId(""), false);
  assert.equal(isValidClientId("   "), false);
  assert.equal(isValidClientId(null), false);
  assert.equal(isValidClientId(undefined), false);
  assert.equal(isValidClientId(42), false);
});

test("CLIENT_ID_PATTERN matches the canonical 8-4-4-4-12 layout", () => {
  assert.match(VALID_CLIENT_ID, CLIENT_ID_PATTERN);
  assert.match(ANOTHER_VALID_CLIENT_ID, CLIENT_ID_PATTERN);
  assert.doesNotMatch("not-a-uuid", CLIENT_ID_PATTERN);
});

test("clientIdFilePath resolves under the configured state directory", () => {
  const resolved = clientIdFilePath("./outlook-state");
  assert.equal(resolved, path.resolve("./outlook-state", "client-id.txt"));
});

test("persistClientId writes a file with mode 0600 inside a 0700 directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-setup-"));
  try {
    const { file } = await persistClientId({ stateDir: root, clientId: VALID_CLIENT_ID });
    const fileStat = await stat(file);
    const dirStat = await stat(path.dirname(file));
    assert.equal(file, path.join(root, "client-id.txt"));
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(dirStat.mode & 0o777, 0o700);
    const contents = await readFile(file, "utf8");
    assert.equal(contents.trim(), VALID_CLIENT_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistClientId rejects malformed client IDs without touching the filesystem", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-setup-"));
  try {
    await assert.rejects(
      () => persistClientId({ stateDir: root, clientId: "not-a-uuid" }),
      /not a valid/i,
    );
    // No file was created on the rejection path.
    await assert.rejects(
      () => readFile(path.join(root, "client-id.txt"), "utf8"),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadStoredClientId returns null when the file does not exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-setup-"));
  try {
    const result = await loadStoredClientId({ stateDir: root });
    assert.equal(result, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadStoredClientId reads and trims a persisted valid client ID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-setup-"));
  try {
    await persistClientId({ stateDir: root, clientId: VALID_CLIENT_ID });
    const result = await loadStoredClientId({ stateDir: root });
    assert.equal(result, VALID_CLIENT_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadStoredClientId returns null when the persisted content is malformed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-setup-"));
  try {
    const { writeFile, chmod } = await import("node:fs/promises");
    const file = path.join(root, "client-id.txt");
    await writeFile(file, "not-a-uuid\n", { mode: 0o600 });
    await chmod(file, 0o600);
    const result = await loadStoredClientId({ stateDir: root });
    assert.equal(result, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveClientIdFromEnv accepts a valid env value and rejects a malformed one", () => {
  assert.equal(resolveClientIdFromEnv({ OUTLOOK_CLIENT_ID: VALID_CLIENT_ID }), VALID_CLIENT_ID);
  assert.equal(resolveClientIdFromEnv({ OUTLOOK_CLIENT_ID: "   " }), null);
  assert.equal(resolveClientIdFromEnv({}), null);
  assert.throws(() => resolveClientIdFromEnv({ OUTLOOK_CLIENT_ID: "not-a-uuid" }), /not a valid/i);
});

test("resolveClientId prefers env over file over prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-setup-"));
  try {
    // File present but env overrides.
    await persistClientId({ stateDir: root, clientId: ANOTHER_VALID_CLIENT_ID });
    const resolved = await resolveClientId({
      envClientId: VALID_CLIENT_ID,
      stateDir: root,
      isInteractive: true,
    });
    assert.equal(resolved.clientId, VALID_CLIENT_ID);
    assert.equal(resolved.source, "env");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveClientId falls back to the persisted file when env is empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-setup-"));
  try {
    await persistClientId({ stateDir: root, clientId: VALID_CLIENT_ID });
    const resolved = await resolveClientId({
      envClientId: "",
      stateDir: root,
      isInteractive: true,
    });
    assert.equal(resolved.clientId, VALID_CLIENT_ID);
    assert.equal(resolved.source, "file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveClientId prompts when no env and no file exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-setup-"));
  try {
    const readLine = fakeReadLine([VALID_CLIENT_ID]);
    const resolved = await resolveClientId({
      envClientId: undefined,
      stateDir: root,
      isInteractive: true,
      readLine,
    });
    assert.equal(resolved.clientId, VALID_CLIENT_ID);
    assert.equal(resolved.source, "prompt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveClientId throws clearly when no source exists in noninteractive mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-setup-"));
  try {
    await assert.rejects(
      () =>
        resolveClientId({
          envClientId: undefined,
          stateDir: root,
          isInteractive: false,
        }),
      /OUTLOOK_CLIENT_ID is required/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promptForClientId re-asks until a valid UUID is supplied", async () => {
  const stderr = captureStderr();
  const readLine = fakeReadLine(["", "still-not-a-uuid", VALID_CLIENT_ID]);
  const result = await promptForClientId({ readLine, stderr: stderr.write, isInteractive: true });
  assert.equal(result, VALID_CLIENT_ID);
  assert.ok(stderr.lines.some((line) => /required/i.test(line)));
  assert.ok(stderr.lines.some((line) => /not a valid/i.test(line)));
});

test("promptForClientId rejects EOF without a saved value", async () => {
  const stderr = captureStderr();
  const readLine = fakeReadLine([]);
  await assert.rejects(
    () => promptForClientId({ readLine, stderr: stderr.write, isInteractive: true }),
    /no client ID was supplied/i,
  );
});

test("promptForClientId refuses to run in noninteractive mode", async () => {
  await assert.rejects(
    () => promptForClientId({ readLine: fakeReadLine([]), isInteractive: false }),
    /interactively/i,
  );
});
