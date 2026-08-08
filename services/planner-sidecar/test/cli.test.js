import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { main, parseCliArgs } from '../src/cli.js';

test('parseCliArgs recognizes onboard profiles, serve, help, and version', () => {
  assert.deepEqual(parseCliArgs(['onboard']), { command: 'onboard', profile: 'default' });
  assert.deepEqual(parseCliArgs(['onboard', 'work']), { command: 'onboard', profile: 'work' });
  assert.deepEqual(parseCliArgs(['serve']), { command: 'serve' });
  assert.deepEqual(parseCliArgs(['--help']), { command: 'help' });
  assert.deepEqual(parseCliArgs(['-h']), { command: 'help' });
  assert.deepEqual(parseCliArgs(['--version']), { command: 'version', version: '0.2.0' });
});

test('parseCliArgs marks missing and unknown commands as usage errors', () => {
  assert.deepEqual(parseCliArgs([]), { command: 'help', unknown: true });
  assert.deepEqual(parseCliArgs(['nope']), { command: 'help', unknown: true });
  assert.deepEqual(parseCliArgs(['serve', 'extra']), { command: 'help', unknown: true });
});

test('main creates the configured state directory with mode 0700 and dispatches onboard', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'planner-sidecar-cli-'));
  const stateDir = path.join(root, 'nested', 'state');
  let received = null;

  try {
    const exitCode = await main(['onboard', 'work'], {
      env: { PLANNER_STATE_DIR: stateDir },
      runLoginImpl: async (options) => {
        received = options;
        return { exitCode: 0 };
      },
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(exitCode, 0);
    assert.equal(received.profile, 'work');
    assert.equal(received.stateDir, path.resolve(stateDir));
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main dispatches serve and maps startup failures without leaking messages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'planner-sidecar-cli-'));
  const output = [];
  const errors = [];

  try {
    const exitCode = await main(['serve'], {
      env: { PLANNER_STATE_DIR: root, PORT: '4321' },
      listenImpl: async (port) => ({ port, close: async () => {} }),
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(output, []);
    assert.deepEqual(errors, ['Planner sidecar listening on 0.0.0.0:4321']);

    errors.length = 0;
    const failedCode = await main(['serve'], {
      env: { PLANNER_STATE_DIR: root },
      listenImpl: async () => { throw new Error('secret startup detail'); },
      stdout: () => {},
      stderr: (line) => errors.push(line),
    });
    assert.equal(failedCode, 1);
    assert.equal(errors.join('\n').includes('secret startup detail'), false);
    assert.match(errors[0], /failed to start/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main gives safe network guidance when onboarding cannot reach Microsoft login', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'planner-sidecar-cli-'));
  const errors = [];
  try {
    const exitCode = await main(['onboard'], {
      env: { PLANNER_STATE_DIR: root },
      runLoginImpl: async () => ({ exitCode: 5 }),
      stdout: () => {},
      stderr: (line) => errors.push(line),
    });
    assert.equal(exitCode, 5);
    assert.deepEqual(errors, ['Cannot reach login.microsoftonline.com. Check the network and try again.']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main prints help/version and returns code 2 for unknown commands', async () => {
  const stdout = [];
  const stderr = [];
  assert.equal(await main(['--help'], { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }), 0);
  assert.match(stdout[0], /planner-sidecar onboard/);
  assert.equal(await main(['--version'], { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }), 0);
  assert.equal(stdout.at(-1), '0.2.0');
  assert.equal(await main(['wat'], { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }), 2);
  assert.match(stderr.at(-1), /planner-sidecar onboard/);
});
