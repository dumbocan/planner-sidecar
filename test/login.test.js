import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  AuthRequiredError,
  ConsentDeniedError,
  DeviceCodeExpiredError,
  NetworkError,
  parseLoginArgs,
  runLogin,
} from '../src/login.js';

const SCOPES = ['Tasks.ReadWrite', 'Group.Read.All'];

const DEVICE_CODE_RESPONSE = {
  userCode: 'ABCD-1234',
  deviceCode: 'DC-1234',
  verificationUri: 'https://microsoft.com/devicelogin',
  expiresIn: 900,
  interval: 5,
  message: 'To sign in, open https://microsoft.com/devicelogin and enter: ABCD-1234',
};

const ACCESS_TOKEN_RESULT = {
  accessToken: 'token-abc',
  expiresOn: new Date('2030-01-01T00:00:00Z'),
  account: {
    homeAccountId: 'hid',
    username: 'j@d',
    name: 'J',
    localAccountId: 'l',
    environment: 'env',
    realm: 'realm',
    authorityType: 'MSSTS',
    tenantProfiles: [],
  },
};

function makeFakeAppState({ authenticate, acquireTokenSilent, getAllAccounts } = {}) {
  const calls = { deviceCode: [], silent: [], allAccounts: 0 };
  return {
    calls,
    fakeApp: {
      async acquireTokenByDeviceCode(request) {
        calls.deviceCode.push(request);
        request.deviceCodeCallback(DEVICE_CODE_RESPONSE);
        const result = await authenticate(request);
        if (this.cachePlugin?.afterCacheAccess) {
          await this.cachePlugin.afterCacheAccess({
            cacheHasChanged: true,
            cache: { serialize: () => JSON.stringify({ AccessToken: { entry: {} } }) },
          });
        }
        return result;
      },
      async acquireTokenSilent(request) {
        calls.silent.push(request);
        if (acquireTokenSilent) return await acquireTokenSilent(request);
        throw new Error('test wiring: acquireTokenSilent called without wiring');
      },
      async getAllAccounts() {
        calls.allAccounts += 1;
        if (getAllAccounts) return await getAllAccounts();
        return [];
      },
    },
  };
}

function makePublicClientApplicationImpl(fakeApp) {
  return class {
    constructor(options = {}) {
      Object.assign(this, fakeApp);
      this.cachePlugin = options?.cache?.cachePlugin ?? null;
    }
  };
}

async function makeTempStateDir() {
  return await mkdtemp(path.join(tmpdir(), 'planner-sidecar-login-'));
}

test('parseLoginArgs returns the default profile for `node src/login.js`', () => {
  assert.deepEqual(parseLoginArgs(['node', 'src/login.js']), { profile: 'default' });
});

test('parseLoginArgs takes the profile id from the first positional arg', () => {
  assert.deepEqual(parseLoginArgs(['node', 'src/login.js', 'work']), { profile: 'work' });
  assert.deepEqual(parseLoginArgs(['node', 'src/login.js', 'javier-2026']), { profile: 'javier-2026' });
});

test('parseLoginArgs rejects malformed argv structures', () => {
  assert.throws(() => parseLoginArgs([]), /argv/i);
  assert.throws(() => parseLoginArgs(['node']), /argv/i);
  assert.throws(() => parseLoginArgs(['node', 'src/login.js', '..']), /profile id/i);
  assert.throws(() => parseLoginArgs(['node', 'src/login.js', 'Default']), /profile id/i);
  assert.throws(() => parseLoginArgs(['node', 'src/login.js', 'a/b']), /profile id/i);
  assert.throws(() => parseLoginArgs(['node', 'src/login.js', 'a'.repeat(65)]), /profile id/i);
  assert.throws(() => parseLoginArgs(['node', 'src/login.js', '']), /profile id/i);
  assert.throws(() => parseLoginArgs(['node', 'src/login.js', 'work', 'extra']), /argv/i);
  assert.throws(() => parseLoginArgs(['node', 'src/login.js', 'work', '--flag']), /argv/i);
  assert.throws(() => parseLoginArgs(['node', 'src/login.js', 42]), /profile id/i);
});

test('runLogin uses the built-in client ID when no client configuration is provided', async () => {
  const originalClientId = process.env.PLANNER_CLIENT_ID;
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({ authenticate: async () => ACCESS_TOKEN_RESULT });
  let authOptions = null;

  try {
    delete process.env.PLANNER_CLIENT_ID;
    const result = await runLogin({
      profile: 'default',
      stateDir,
      PublicClientApplicationImpl: class {
        constructor(options) {
          authOptions = options.auth;
          Object.assign(this, fakeApp);
          this.cachePlugin = options.cache.cachePlugin;
        }
      },
      stdout: () => {},
      audit: () => {},
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(authOptions, {
      clientId: 'c4fad54f-28a3-432d-92c8-f72a5f970a83',
      authority: 'https://login.microsoftonline.com/common',
    });
  } finally {
    if (originalClientId === undefined) delete process.env.PLANNER_CLIENT_ID;
    else process.env.PLANNER_CLIENT_ID = originalClientId;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('runLogin writes the cache file with mode 0600 on the happy path', async () => {
  const stateDir = await makeTempStateDir();
  const { calls, fakeApp } = makeFakeAppState({ authenticate: async () => ACCESS_TOKEN_RESULT });
  const writes = [];
  const logs = [];
  const result = await runLogin({
    profile: 'default',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: makePublicClientApplicationImpl(fakeApp),
    stdout: (line) => writes.push(line),
    audit: (line) => logs.push(line),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.profile, 'default');
  const cacheFile = path.join(stateDir, 'profiles', 'default', 'token-cache.json');
  const info = await stat(cacheFile);
  assert.equal(info.mode & 0o600, 0o600, `mode 0600 owner rw bits expected, got ${(info.mode & 0o777).toString(8)}`);
  const raw = await readFile(cacheFile, 'utf8');
  assert.match(raw, /AccessToken/);
  // stdout surfaces the verification URI and user code from the device code response.
  assert.ok(writes.some((line) => line.includes('https://microsoft.com/devicelogin')));
  assert.ok(writes.some((line) => line.includes('ABCD-1234')));
  assert.equal(calls.deviceCode.length, 1);
  assert.deepEqual(calls.deviceCode[0].scopes, SCOPES);
  assert.equal(calls.silent.length, 0);
  assert.equal(calls.allAccounts, 0);
  await rm(stateDir, { recursive: true, force: true });
});

test('runLogin calls ensureProfileDir and writes the cache inside the profile dir', async () => {
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({ authenticate: async () => ACCESS_TOKEN_RESULT });
  await runLogin({
    profile: 'work',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: makePublicClientApplicationImpl(fakeApp),
    stdout: () => {},
    audit: () => {},
  });
  const cacheFile = path.join(stateDir, 'profiles', 'work', 'token-cache.json');
  const info = await stat(cacheFile);
  assert.equal(info.isFile(), true);
  await rm(stateDir, { recursive: true, force: true });
});

test('runLogin never writes a token string to the audit stream', async () => {
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({ authenticate: async () => ACCESS_TOKEN_RESULT });
  const logs = [];
  await runLogin({
    profile: 'default',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: makePublicClientApplicationImpl(fakeApp),
    stdout: () => {},
    audit: (line) => logs.push(line),
  });
  for (const token of ['token-abc', 'AccessToken', 'Account', 'homeAccountId']) {
    const combined = logs.join('\n');
    assert.equal(combined.includes(token), false, `audit log must not contain "${token}"`);
  }
  await rm(stateDir, { recursive: true, force: true });
});

test('runLogin returns ExitCode 3 when the device code expires', async () => {
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({
    authenticate: async () => {
      const error = new Error('Device code expired');
      error.errorCode = 'code_expired';
      error.name = 'ServerError';
      throw error;
    },
  });
  const result = await runLogin({
    profile: 'default',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: makePublicClientApplicationImpl(fakeApp),
    stdout: () => {},
    audit: () => {},
  });
  assert.equal(result.exitCode, 3);
  assert.ok(result.error instanceof DeviceCodeExpiredError);
  await rm(stateDir, { recursive: true, force: true });
});

test('runLogin returns ExitCode 4 when the user denies consent', async () => {
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({
    authenticate: async () => {
      const error = new Error('user_cancel');
      error.errorCode = 'user_cancel';
      error.name = 'ServerError';
      throw error;
    },
  });
  const result = await runLogin({
    profile: 'default',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: makePublicClientApplicationImpl(fakeApp),
    stdout: () => {},
    audit: () => {},
  });
  assert.equal(result.exitCode, 4);
  assert.ok(result.error instanceof ConsentDeniedError);
  await rm(stateDir, { recursive: true, force: true });
});

test('runLogin returns ExitCode 5 when the network is unreachable', async () => {
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({
    authenticate: async () => {
      const error = new Error('getaddrinfo ENOTFOUND');
      error.code = 'ENOTFOUND';
      throw error;
    },
  });
  const result = await runLogin({
    profile: 'default',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: makePublicClientApplicationImpl(fakeApp),
    stdout: () => {},
    audit: () => {},
  });
  assert.equal(result.exitCode, 5);
  assert.ok(result.error instanceof NetworkError);
  await rm(stateDir, { recursive: true, force: true });
});

test('runLogin returns ExitCode 6 when the profile dir is unwritable', async () => {
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({ authenticate: async () => ACCESS_TOKEN_RESULT });
  // Mark the profiles parent as read-only so ensureProfileDir fails.
  const { chmod } = await import('node:fs/promises');
  await mkdir(path.join(stateDir, 'profiles'), { recursive: true });
  await chmod(path.join(stateDir, 'profiles'), 0o500);
  const result = await runLogin({
    profile: 'default',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: makePublicClientApplicationImpl(fakeApp),
    stdout: () => {},
    audit: () => {},
  });
  // Restore so cleanup works.
  await chmod(path.join(stateDir, 'profiles'), 0o700);
  assert.equal(result.exitCode, 6);
  await rm(stateDir, { recursive: true, force: true });
});

test('runLogin logs the success audit event with no token content', async () => {
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({ authenticate: async () => ACCESS_TOKEN_RESULT });
  const logs = [];
  await runLogin({
    profile: 'default',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: makePublicClientApplicationImpl(fakeApp),
    stdout: () => {},
    audit: (line) => logs.push(line),
  });
  assert.ok(logs.length >= 1);
  const events = logs.map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.event === 'planner_login_success' && event.profile === 'default'));
  await rm(stateDir, { recursive: true, force: true });
});

test('runLogin logs the failure audit event with the error constructor name only', async () => {
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({
    authenticate: async () => {
      const error = new Error('User denied consent');
      error.errorCode = 'user_cancel';
      error.name = 'ServerError';
      throw error;
    },
  });
  const logs = [];
  await runLogin({
    profile: 'default',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: class { constructor() { Object.assign(this, fakeApp); } },
    stdout: () => {},
    audit: (line) => logs.push(line),
  });
  const events = logs.map((line) => JSON.parse(line));
  const failure = events.find((event) => event.event === 'planner_login_failure');
  assert.ok(failure, 'a planner_login_failure event must be recorded');
  assert.equal(failure.error, 'ConsentDeniedError');
  assert.equal(failure.profile, 'default');
  for (const token of ['AccessToken', 'Account', 'token-abc', 'user_cancel']) {
    assert.equal(logs.join('\n').includes(token), false, `audit log must not contain "${token}"`);
  }
  await rm(stateDir, { recursive: true, force: true });
});

test('runLogin never surfaces the access token on stdout', async () => {
  const stateDir = await makeTempStateDir();
  const { fakeApp } = makeFakeAppState({ authenticate: async () => ACCESS_TOKEN_RESULT });
  const writes = [];
  await runLogin({
    profile: 'default',
    stateDir,
    clientId: 'cid',
    PublicClientApplicationImpl: makePublicClientApplicationImpl(fakeApp),
    stdout: (line) => writes.push(line),
    audit: () => {},
  });
  const combined = writes.join('\n');
  assert.equal(combined.includes('token-abc'), false);
  assert.equal(combined.includes('AccessToken'), false);
  await rm(stateDir, { recursive: true, force: true });
});

// Helper used by the read-only test above.
import { mkdir } from 'node:fs/promises';
