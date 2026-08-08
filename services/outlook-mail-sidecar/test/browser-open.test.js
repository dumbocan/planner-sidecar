import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { resolveOpener, tryOpenBrowser } from "../src/browser-open.js";

// Defer event firing until the test explicitly schedules it. setImmediate
// would race the listener attachment inside tryOpenBrowser; using manual
// emitter helpers ensures the event is emitted only after the Promise
// executor has registered its `once("spawn")` / `once("error")` handlers.
function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.fire = (event, ...args) => child.emit(event, ...args);
  return child;
}

function fakeFailingChild(errorCode = "ENOENT") {
  const child = fakeChild();
  child.fireError = () => {
    const error = new Error(`spawn ${errorCode}`);
    error.code = errorCode;
    child.emit("error", error);
  };
  return child;
}

function makeSpawn({ returnValue, fn }) {
  return (command, args, options) => {
    fn(command, args, options);
    return returnValue;
  };
}

function flushAsync() {
  // Wait for the immediate phase so any pending emit has a chance to run after
  // listeners are attached inside tryOpenBrowser.
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test("resolveOpener returns xdg-open with no extra args on Linux", () => {
  const opener = resolveOpener({ platform: "linux" });
  assert.equal(opener.command, "xdg-open");
  assert.deepEqual(opener.argsPrefix, []);
});

test("resolveOpener returns `open` on macOS", () => {
  const opener = resolveOpener({ platform: "darwin" });
  assert.equal(opener.command, "open");
  assert.deepEqual(opener.argsPrefix, []);
});

test("resolveOpener uses cmd start on Windows", () => {
  const opener = resolveOpener({ platform: "win32" });
  assert.equal(opener.command, "cmd");
  assert.deepEqual(opener.argsPrefix, ["/c", "start", '""']);
});

test("tryOpenBrowser passes the URL as a positional arg and never via shell", async () => {
  let captured = null;
  const child = fakeChild();
  const spawnImpl = makeSpawn({
    returnValue: child,
    fn(command, args, options) {
      captured = { command, args, options };
    },
  });
  const promise = tryOpenBrowser("https://example.com/devicelogin", {
    spawnImpl,
    platform: "linux",
    timeoutMs: 200,
  });
  await flushAsync();
  child.fire("spawn");
  const outcome = await promise;
  assert.equal(outcome.opened, true);
  assert.equal(outcome.error, null);
  assert.equal(captured.command, "xdg-open");
  assert.deepEqual(captured.args, ["https://example.com/devicelogin"]);
  assert.equal(captured.options.shell, false, "shell must be disabled to avoid interpolation");
  assert.equal(captured.options.stdio, "ignore");
});

test("tryOpenBrowser forwards the URL only — caller-supplied URLs are passed verbatim", async () => {
  let captured = null;
  const child = fakeChild();
  const spawnImpl = makeSpawn({
    returnValue: child,
    fn(command, args, options) {
      captured = { command, args, options };
    },
  });
  // A URL with characters that would break a shell is still passed as one argv
  // entry; with shell:false there is no interpolation surface.
  const hostile = "https://login.microsoftonline.com/devicelogin?u=foo;rm%20-rf%20~";
  const promise = tryOpenBrowser(hostile, { spawnImpl, platform: "linux", timeoutMs: 200 });
  await flushAsync();
  child.fire("spawn");
  await promise;
  assert.deepEqual(captured.args, [hostile]);
  assert.equal(
    captured.args.length,
    1,
    "the URL must be a single argv entry, never shell-interpolated",
  );
});

test("tryOpenBrowser detaches the child so the opener outlives the call", async () => {
  let unrefed = false;
  const child = fakeChild();
  child.unref = () => {
    unrefed = true;
  };
  const spawnImpl = makeSpawn({ returnValue: child, fn() {} });
  const promise = tryOpenBrowser("https://example.com/devicelogin", {
    spawnImpl,
    platform: "linux",
    timeoutMs: 200,
  });
  await flushAsync();
  child.fire("spawn");
  await promise;
  assert.equal(unrefed, true);
});

test("tryOpenBrowser resolves with opened:false when spawn throws synchronously", async () => {
  const spawnImpl = () => {
    const error = new Error("missing binary");
    error.code = "ENOENT";
    throw error;
  };
  const outcome = await tryOpenBrowser("https://example.com/devicelogin", {
    spawnImpl,
    platform: "linux",
    timeoutMs: 100,
  });
  assert.equal(outcome.opened, false);
  assert.equal(outcome.error, "ENOENT");
});

test("tryOpenBrowser resolves with opened:false when the child emits an async error", async () => {
  const child = fakeFailingChild("ENOENT");
  const spawnImpl = makeSpawn({ returnValue: child, fn() {} });
  const promise = tryOpenBrowser("https://example.com/devicelogin", {
    spawnImpl,
    platform: "linux",
    timeoutMs: 500,
  });
  await flushAsync();
  child.fireError();
  const outcome = await promise;
  assert.equal(outcome.opened, false);
  assert.equal(outcome.error, "ENOENT");
});

test("tryOpenBrowser resolves with opened:false when no spawn event arrives before the timeout", async () => {
  const child = fakeChild();
  // Never fires — simulates a hung browser launcher.
  const spawnImpl = makeSpawn({ returnValue: child, fn() {} });
  const outcome = await tryOpenBrowser("https://example.com/devicelogin", {
    spawnImpl,
    platform: "linux",
    timeoutMs: 30,
  });
  assert.equal(outcome.opened, false);
  assert.equal(outcome.error, "timeout");
});

test("tryOpenBrowser accepts a clean exit as proof of successful launch", async () => {
  const child = fakeChild();
  const spawnImpl = makeSpawn({ returnValue: child, fn() {} });
  const promise = tryOpenBrowser("https://example.com/devicelogin", {
    spawnImpl,
    platform: "linux",
    timeoutMs: 200,
  });
  await flushAsync();
  child.fire("exit", 0);
  const outcome = await promise;
  assert.equal(outcome.opened, true);
});

test("tryOpenBrowser rejects empty or non-string URLs without spawning anything", async () => {
  let called = false;
  const spawnImpl = makeSpawn({
    returnValue: fakeChild(),
    fn() {
      called = true;
    },
  });
  for (const url of ["", null, undefined, 42]) {
    const outcome = await tryOpenBrowser(url, { spawnImpl, platform: "linux", timeoutMs: 50 });
    assert.equal(outcome.opened, false);
    assert.equal(outcome.error, "no_url");
  }
  assert.equal(called, false, "spawn must not be called for empty URLs");
});

test("tryOpenBrowser returns spawn_failed when spawn returns a child without a pid", async () => {
  const spawnImpl = () => ({ pid: 0, unref() {} });
  const outcome = await tryOpenBrowser("https://example.com/devicelogin", {
    spawnImpl,
    platform: "linux",
    timeoutMs: 50,
  });
  assert.equal(outcome.opened, false);
  assert.equal(outcome.error, "spawn_failed");
});
