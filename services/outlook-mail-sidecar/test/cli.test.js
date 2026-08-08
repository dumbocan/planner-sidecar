import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runOnboarding, runSetup, parseArgs } from "../src/cli.js";

const VALID_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const ANOTHER_VALID_CLIENT_ID = "abcdef01-2345-6789-abcd-ef0123456789";

function fakeReadLine(answers) {
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

function captureStd() {
  const lines = [];
  return {
    lines,
    write(line) {
      lines.push(line);
    },
  };
}

function makeMsalStub({
  verificationUri = "https://microsoft.com/devicelogin",
  message = "open url",
} = {}) {
  return class FakePublicClientApplication {
    constructor(config) {
      this.config = config;
      this.cachePlugin = config?.cache?.cachePlugin;
    }
    async getTokenCache() {
      return {
        getAllAccounts: async () => [{ username: "user@example.com" }],
      };
    }
    async acquireTokenByDeviceCode({ deviceCodeCallback }) {
      deviceCodeCallback({
        userCode: "ABCD-EFGH",
        deviceCode: "device-code",
        verificationUri,
        expiresOn: new Date(Date.now() + 600_000),
        interval: 5,
        message,
      });
      return { accessToken: "fake-access-token" };
    }
  };
}

test("runSetup persists a prompted client ID with restrictive permissions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-cli-setup-"));
  try {
    const stdout = captureStd();
    const stderr = captureStd();
    const readLine = fakeReadLine([VALID_CLIENT_ID]);
    const result = await runSetup({
      stateDir: root,
      isInteractive: true,
      readLine,
      stdout: stdout.write,
      stderr: stderr.write,
    });
    assert.equal(result.clientId, VALID_CLIENT_ID);
    assert.equal(result.source, "prompt");
    const fileStat = await stat(result.file);
    const dirStat = await stat(path.dirname(result.file));
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(dirStat.mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSetup reports an existing file and does not re-prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-cli-setup-"));
  try {
    const stdout = captureStd();
    const stderr = captureStd();
    const readLine = fakeReadLine([]);
    // Pre-seed the file the way a previous `npm run setup` would have.
    const { writeFile, chmod, mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    await chmod(root, 0o700);
    await writeFile(path.join(root, "client-id.txt"), `${VALID_CLIENT_ID}\n`, { mode: 0o600 });
    await chmod(path.join(root, "client-id.txt"), 0o600);

    const result = await runSetup({
      stateDir: root,
      isInteractive: true,
      readLine,
      stdout: stdout.write,
      stderr: stderr.write,
    });
    assert.equal(result.clientId, VALID_CLIENT_ID);
    assert.equal(result.source, "file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSetup reports env-only and never persists when OUTLOOK_CLIENT_ID is set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-cli-setup-"));
  try {
    const stdout = captureStd();
    const stderr = captureStd();
    const result = await runSetup({
      stateDir: root,
      envClientId: VALID_CLIENT_ID,
      isInteractive: true,
      readLine: fakeReadLine([]),
      stdout: stdout.write,
      stderr: stderr.write,
    });
    assert.equal(result.clientId, VALID_CLIENT_ID);
    assert.equal(result.source, "env");
    assert.equal(result.file, null);
    // No file should have been created on the env path.
    await assert.rejects(
      () => stat(path.join(root, "client-id.txt")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runOnboarding reads env, then file, then prompts — and opens the MSAL verification URI only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-cli-onboard-"));
  try {
    let openedUrl = null;
    const openImpl = async (url) => {
      openedUrl = url;
      return { opened: true, error: null };
    };
    const stdout = captureStd();
    const stderr = captureStd();
    const result = await runOnboarding({
      stateDir: root,
      clientId: undefined,
      isInteractive: true,
      readLine: fakeReadLine([ANOTHER_VALID_CLIENT_ID]),
      openImpl,
      PublicClientApplicationImpl: makeMsalStub({
        verificationUri: "https://microsoft.com/devicelogin",
        message: "Open https://microsoft.com/devicelogin and enter ABCD-EFGH",
      }),
      stdout: stdout.write,
      stderr: stderr.write,
    });
    assert.equal(result.authenticated, true);
    assert.equal(openedUrl, "https://microsoft.com/devicelogin");
    // The MSAL message is the canonical fallback; it must always be printed,
    // even when the browser launches successfully.
    assert.ok(
      stdout.lines.some((line) => line.includes("Open https://microsoft.com/devicelogin")),
      "device-code message must be printed as a fallback",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runOnboarding falls back gracefully when the browser opener fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-cli-onboard-"));
  try {
    let opened = false;
    const openImpl = async () => {
      opened = true;
      return { opened: false, error: "ENOENT" };
    };
    const stdout = captureStd();
    const stderr = captureStd();
    await runOnboarding({
      stateDir: root,
      clientId: VALID_CLIENT_ID,
      isInteractive: false,
      openImpl,
      PublicClientApplicationImpl: makeMsalStub({
        verificationUri: "https://microsoft.com/devicelogin",
        message: "Open https://microsoft.com/devicelogin and enter ABCD-EFGH",
      }),
      stdout: stdout.write,
      stderr: stderr.write,
    });
    assert.equal(opened, true, "browser opener must be invoked");
    assert.ok(
      stderr.lines.some((line) => line.includes("outlook_browser_open_failed")),
      "failure is audit-logged with the structured event",
    );
    assert.ok(
      stderr.lines.some((line) => /Browser auto-open failed/i.test(line)),
      "operator-facing fallback instruction is emitted",
    );
    assert.ok(
      stdout.lines.some((line) => line.includes("https://microsoft.com/devicelogin")),
      "the MSAL device-code message stays visible as the accessible fallback",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runOnboarding surfaces a clean error in noninteractive mode without prompting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-cli-onboard-"));
  try {
    const stdout = captureStd();
    const stderr = captureStd();
    await assert.rejects(
      () =>
        runOnboarding({
          stateDir: root,
          clientId: undefined,
          isInteractive: false,
          stdout: stdout.write,
          stderr: stderr.write,
          PublicClientApplicationImpl: makeMsalStub(),
        }),
      /OUTLOOK_CLIENT_ID is required/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseArgs accepts `setup` and `onboard` and rejects unknown commands", () => {
  assert.deepEqual(parseArgs(["setup"]), { command: "setup" });
  assert.deepEqual(parseArgs(["onboard"]), { command: "onboard" });
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(["deploy"]), /Usage/);
  assert.throws(() => parseArgs(["help"]), /Usage/);
});
