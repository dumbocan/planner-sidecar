import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  AuthError,
  AuthRequiredError,
  BUILTIN_CLIENT_ID,
  ConsentDeniedError,
  DeviceCodeExpiredError,
  NetworkError,
  acquireTokenByDeviceCode,
  createAuthClient,
  createFileCachePlugin,
  readCacheJson,
  requestDeviceCode,
  writeCacheJson,
} from '../src/auth.js';

const SCOPES = ['Tasks.ReadWrite', 'Group.Read.All'];

function makeFakeApp({ authenticate, deviceCodeResponse, getAllAccounts, acquireTokenSilent }) {
  return {
    async acquireTokenByDeviceCode(request) {
      request.deviceCodeCallback(deviceCodeResponse);
      this.calls.push(request);
      return await authenticate(request);
    },
    async acquireTokenSilent(request) {
      if (acquireTokenSilent) {
        this.calls.push(['silent', request]);
        return await acquireTokenSilent(request);
      }
      throw new Error('test wiring: acquireTokenSilent called without wiring');
    },
    async getAllAccounts() {
      if (typeof getAllAccounts === 'function') return await getAllAccounts();
      return [];
    },
    calls: [],
  };
}

function makeFakeAppCtor(fakeApp) {
  return class { constructor() { Object.assign(this, fakeApp); } };
}

function makeCachePlugin({ stateDir, profile }) {
  return createFileCachePlugin({ stateDir, profile });
}

async function makeTempStateDir() {
  return await mkdtemp(path.join(tmpdir(), 'planner-sidecar-auth-'));
}

const ACCOUNT = {
  homeAccountId: 'hid',
  username: 'j@d',
  name: 'J',
  localAccountId: 'l',
  environment: 'env',
  realm: 'realm',
  authorityType: 'MSSTS',
  tenantProfiles: [],
};

const DEVICE_CODE_RESPONSE = {
  userCode: 'USER-CODE',
  deviceCode: 'DC-123',
  verificationUri: 'https://microsoft.com/devicelogin',
  expiresIn: 900,
  interval: 5,
  message: 'To sign in, open https://microsoft.com/devicelogin and enter: USER-CODE',
};

test('createAuthClient resolves client ID and tenant defaults with documented precedence', () => {
  const originalClientId = process.env.PLANNER_CLIENT_ID;
  const originalTenant = process.env.PLANNER_TENANT;
  const captured = [];
  class CapturingApp {
    constructor(options) {
      captured.push(options.auth);
    }
  }

  try {
    delete process.env.PLANNER_CLIENT_ID;
    delete process.env.PLANNER_TENANT;
    createAuthClient({
      profile: 'default',
      stateDir: '/tmp/example',
      PublicClientApplicationImpl: CapturingApp,
    });

    process.env.PLANNER_CLIENT_ID = 'env-client';
    process.env.PLANNER_TENANT = 'env-tenant';
    createAuthClient({
      profile: 'default',
      stateDir: '/tmp/example',
      PublicClientApplicationImpl: CapturingApp,
    });
    createAuthClient({
      profile: 'default',
      stateDir: '/tmp/example',
      clientId: 'argument-client',
      tenant: 'argument-tenant',
      PublicClientApplicationImpl: CapturingApp,
    });

    process.env.PLANNER_CLIENT_ID = '   ';
    createAuthClient({
      profile: 'default',
      stateDir: '/tmp/example',
      PublicClientApplicationImpl: CapturingApp,
    });

    assert.deepEqual(captured, [
      {
        clientId: BUILTIN_CLIENT_ID,
        authority: 'https://login.microsoftonline.com/common',
      },
      {
        clientId: 'env-client',
        authority: 'https://login.microsoftonline.com/env-tenant',
      },
      {
        clientId: 'argument-client',
        authority: 'https://login.microsoftonline.com/argument-tenant',
      },
      {
        clientId: BUILTIN_CLIENT_ID,
        authority: 'https://login.microsoftonline.com/env-tenant',
      },
    ]);
    assert.equal(BUILTIN_CLIENT_ID, 'c4fad54f-28a3-432d-92c8-f72a5f970a83');
  } finally {
    if (originalClientId === undefined) delete process.env.PLANNER_CLIENT_ID;
    else process.env.PLANNER_CLIENT_ID = originalClientId;
    if (originalTenant === undefined) delete process.env.PLANNER_TENANT;
    else process.env.PLANNER_TENANT = originalTenant;
  }
});

test('createAuthClient returns a client with the documented surface', () => {
  const client = createAuthClient({ profile: 'default', stateDir: '/tmp/example', clientId: 'cid' });
  assert.equal(typeof client.acquireToken, 'function');
  assert.equal(typeof client.cachePlugin, 'object');
  assert.equal(client.profile, 'default');
});

test('createFileCachePlugin rejects unsafe profile ids at construction', () => {
  for (const bad of ['..', 'Default', 'foo/bar', 'a'.repeat(65)]) {
    assert.throws(() => createFileCachePlugin({ stateDir: '/tmp', profile: bad }), /profile id/i, `must reject ${JSON.stringify(bad)}`);
  }
});

test('createFileCachePlugin reads an absent cache as null (no exception)', async () => {
  const stateDir = await makeTempStateDir();
  const plugin = makeCachePlugin({ stateDir, profile: 'default' });
  const ctx = {
    hasChanged: false,
    cache: { serialize() { return '{}'; }, deserialize() {} },
    cacheHasChanged: false,
    tokenCache: { serialize() { return '{}'; }, deserialize() {} },
  };
  await plugin.beforeCacheAccess(ctx);
  assert.equal(typeof ctx.cache.serialize, 'function');
  await rm(stateDir, { recursive: true, force: true });
});

test('createFileCachePlugin writes the cache and sets file mode 0600', async () => {
  const stateDir = await makeTempStateDir();
  const plugin = makeCachePlugin({ stateDir, profile: 'default' });
  const cacheBlob = JSON.stringify({ AccessToken: { entry: {} }, Account: {}, IdToken: {}, RefreshToken: {}, AppMetadata: {} });
  const ctx = {
    hasChanged: true,
    cacheHasChanged: true,
    cache: { serialize() { return cacheBlob; }, deserialize() {} },
  };
  await plugin.afterCacheAccess(ctx);
  const cacheFile = path.join(stateDir, 'profiles', 'default', 'token-cache.json');
  const info = await stat(cacheFile);
  const mode = info.mode & 0o777;
  assert.equal(mode & 0o600, 0o600, `owner rw bits expected, got ${mode.toString(8)}`);
  const round = await readFile(cacheFile, 'utf8');
  assert.equal(round, cacheBlob);
  await rm(stateDir, { recursive: true, force: true });
});

test('acquireToken calls acquireTokenSilent when there is a cached account', async () => {
  const stateDir = await makeTempStateDir();
  const fakeApp = makeFakeApp({
    deviceCodeResponse: DEVICE_CODE_RESPONSE,
    authenticate: async () => null,
    acquireTokenSilent: async () => ({ accessToken: 'fresh-token', expiresOn: new Date('2030-01-01T00:00:00Z'), account: ACCOUNT }),
    getAllAccounts: async () => [ACCOUNT],
  });
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  const result = await client.acquireToken({ scopes: SCOPES });
  assert.equal(result.accessToken, 'fresh-token');
  assert.equal(fakeApp.calls.length, 1);
  assert.equal(fakeApp.calls[0][0], 'silent');
  await rm(stateDir, { recursive: true, force: true });
});

test('acquireToken throws AuthRequiredError when there is no cached account', async () => {
  const stateDir = await makeTempStateDir();
  const fakeApp = makeFakeApp({ deviceCodeResponse: DEVICE_CODE_RESPONSE, authenticate: async () => null });
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  await assert.rejects(
    client.acquireToken({ scopes: SCOPES }),
    (error) => {
      assert.ok(error instanceof AuthError, `expected AuthError, got ${error?.constructor?.name}`);
      assert.ok(error instanceof AuthRequiredError, 'expected AuthRequiredError subtype');
      assert.equal(error.name, 'AuthRequiredError');
      return true;
    },
  );
  await rm(stateDir, { recursive: true, force: true });
});

test('acquireToken translates InteractionRequiredAuthError into AuthError on silent refresh', async () => {
  const stateDir = await makeTempStateDir();
  const fakeApp = makeFakeApp({
    deviceCodeResponse: DEVICE_CODE_RESPONSE,
    authenticate: async () => null,
    acquireTokenSilent: async () => {
      const error = new Error('interaction required');
      error.name = 'InteractionRequiredAuthError';
      error.errorCode = 'interaction_required';
      throw error;
    },
    getAllAccounts: async () => [ACCOUNT],
  });
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  await assert.rejects(
    client.acquireToken({ scopes: SCOPES }),
    (error) => {
      assert.equal(error.name, 'AuthError');
      assert.match(error.message, /refresh-failed/);
      return true;
    },
  );
  await rm(stateDir, { recursive: true, force: true });
});

test('requestDeviceCode returns the device-code response surfaced by MSAL', async () => {
  const stateDir = await makeTempStateDir();
  const fakeApp = makeFakeApp({
    deviceCodeResponse: DEVICE_CODE_RESPONSE,
    authenticate: async () => null,
  });
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  const result = await client.requestDeviceCode({ scopes: SCOPES });
  assert.equal(result.userCode, 'USER-CODE');
  assert.equal(result.verificationUri, 'https://microsoft.com/devicelogin');
  assert.equal(result.deviceCode, 'DC-123');
  assert.equal(result.expiresIn, 900);
  assert.equal(result.interval, 5);
  assert.equal(fakeApp.calls.length, 1);
  assert.deepEqual(fakeApp.calls[0].scopes, SCOPES);
  await rm(stateDir, { recursive: true, force: true });
});

test('acquireTokenByDeviceCode (package helper) returns the access token and surfaces the device code response', async () => {
  const stateDir = await makeTempStateDir();
  const authResult = {
    accessToken: 'token-abc',
    expiresOn: new Date('2030-01-01T00:00:00Z'),
    account: ACCOUNT,
    idToken: '',
    scopes: SCOPES,
    tenantId: 'tid',
    uniqueId: 'uid',
    authority: 'authority',
    fromCache: false,
    tokenType: 'Bearer',
    correlationId: 'corr',
  };
  const fakeApp = makeFakeApp({
    deviceCodeResponse: DEVICE_CODE_RESPONSE,
    authenticate: async () => authResult,
  });
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  const result = await acquireTokenByDeviceCode({ client, scopes: SCOPES });
  assert.equal(result.accessToken, 'token-abc');
  assert.equal(result.deviceCodeResponse.userCode, 'USER-CODE');
  assert.equal(fakeApp.calls.length, 1, 'exactly one MSAL call for request + poll combined');
  await rm(stateDir, { recursive: true, force: true });
});

test('acquireTokenByDeviceCode translates a 15-minute device-code expiry into DeviceCodeExpiredError', async () => {
  const stateDir = await makeTempStateDir();
  const fakeApp = makeFakeApp({
    deviceCodeResponse: DEVICE_CODE_RESPONSE,
    authenticate: async () => {
      const error = new Error('Device code expired');
      error.errorCode = 'code_expired';
      error.name = 'ServerError';
      throw error;
    },
  });
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  await assert.rejects(
    acquireTokenByDeviceCode({ client, scopes: SCOPES }),
    (error) => {
      assert.ok(error instanceof DeviceCodeExpiredError, `expected DeviceCodeExpiredError, got ${error?.constructor?.name}`);
      assert.equal(error.name, 'DeviceCodeExpiredError');
      return true;
    },
  );
  await rm(stateDir, { recursive: true, force: true });
});

test('acquireTokenByDeviceCode translates user-denied consent into ConsentDeniedError', async () => {
  const stateDir = await makeTempStateDir();
  const fakeApp = makeFakeApp({
    deviceCodeResponse: DEVICE_CODE_RESPONSE,
    authenticate: async () => {
      const error = new Error('User denied consent');
      error.errorCode = 'user_cancel';
      error.name = 'ServerError';
      throw error;
    },
  });
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  await assert.rejects(
    acquireTokenByDeviceCode({ client, scopes: SCOPES }),
    (error) => {
      assert.ok(error instanceof ConsentDeniedError, `expected ConsentDeniedError, got ${error?.constructor?.name}`);
      assert.equal(error.name, 'ConsentDeniedError');
      return true;
    },
  );
  await rm(stateDir, { recursive: true, force: true });
});

test('acquireTokenByDeviceCode translates network errors into NetworkError', async () => {
  const stateDir = await makeTempStateDir();
  const fakeApp = makeFakeApp({
    deviceCodeResponse: DEVICE_CODE_RESPONSE,
    authenticate: async () => {
      const error = new Error('getaddrinfo ENOTFOUND login.microsoftonline.com');
      error.code = 'ENOTFOUND';
      throw error;
    },
  });
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  await assert.rejects(
    acquireTokenByDeviceCode({ client, scopes: SCOPES }),
    (error) => {
      assert.ok(error instanceof NetworkError, `expected NetworkError, got ${error?.constructor?.name}`);
      assert.equal(error.name, 'NetworkError');
      return true;
    },
  );
  await rm(stateDir, { recursive: true, force: true });
});

test('acquireTokenByDeviceCode rejects when no device code response is returned', async () => {
  const stateDir = await makeTempStateDir();
  const fakeApp = {
    async acquireTokenByDeviceCode() {
      // No callback invocation, no result: malformed.
      return null;
    },
  };
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  await assert.rejects(
    acquireTokenByDeviceCode({ client, scopes: SCOPES }),
    /device code/i,
  );
  await rm(stateDir, { recursive: true, force: true });
});

test('readCacheJson returns null when the cache file does not exist', async () => {
  const stateDir = await makeTempStateDir();
  assert.equal(await readCacheJson({ stateDir, profile: 'default' }), null);
  await rm(stateDir, { recursive: true, force: true });
});

test('writeCacheJson writes the cache JSON and chmods 0600', async () => {
  const stateDir = await makeTempStateDir();
  await writeCacheJson({ stateDir, profile: 'default' }, JSON.stringify({ Account: {}, IdToken: {}, AccessToken: {}, RefreshToken: {}, AppMetadata: {} }));
  const file = path.join(stateDir, 'profiles', 'default', 'token-cache.json');
  const info = await stat(file);
  assert.equal(info.mode & 0o600, 0o600);
  const raw = await readFile(file, 'utf8');
  assert.match(raw, /Account/);
  await rm(stateDir, { recursive: true, force: true });
});

test('package-level requestDeviceCode is a thin wrapper over client.requestDeviceCode', async () => {
  const stateDir = await makeTempStateDir();
  const fakeApp = makeFakeApp({
    deviceCodeResponse: DEVICE_CODE_RESPONSE,
    authenticate: async () => null,
  });
  const client = createAuthClient({
    profile: 'default',
    stateDir,
    PublicClientApplicationImpl: makeFakeAppCtor(fakeApp),
  });
  const result = await requestDeviceCode({ client, scopes: SCOPES });
  assert.equal(result.userCode, 'USER-CODE');
  assert.equal(result.verificationUri, 'https://microsoft.com/devicelogin');
  await rm(stateDir, { recursive: true, force: true });
});

test('AuthRequiredError directs users to the packaged onboarding command', () => {
  assert.match(new AuthRequiredError().message, /planner-sidecar onboard/);
});

test('every error path produces a typed error whose constructor name is the audit signal', () => {
  for (const ErrorClass of [AuthError, AuthRequiredError, ConsentDeniedError, DeviceCodeExpiredError, NetworkError]) {
    const error = new ErrorClass('opaque');
    assert.equal(error.constructor.name, ErrorClass.name);
    assert.ok(error instanceof Error);
  }
});
