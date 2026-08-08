import path from 'node:path';

import { PublicClientApplication } from '@azure/msal-node';

import { createProfileStore, validateProfileId } from './profile-store.js';

// Public multi-tenant App Registration owned by the Planner sidecar project.
// Client IDs are not secrets; delegated consent and token caches remain tenant-local.
export const BUILTIN_CLIENT_ID = 'c4fad54f-28a3-432d-92c8-f72a5f970a83';

// planner-sidecar wraps MSAL PublicClientApplication, persists the token
// cache via a custom ICachePlugin under
// `<stateDir>/profiles/<id>/token-cache.json` with mode 0600, and exposes a
// typed error surface so server.js can audit-log only the constructor name.
//
// The wrapper never holds secrets in memory longer than a single acquireToken
// call. All console output is owned by login.js (stdout) and server.js
// (stderr); auth.js exposes the result and never logs.

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthRequiredError extends AuthError {
  constructor(message = 'no cached account; run `planner-sidecar onboard`') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class ConsentDeniedError extends AuthError {
  constructor(message = 'user denied consent') {
    super(message);
    this.name = 'ConsentDeniedError';
  }
}

export class DeviceCodeExpiredError extends AuthError {
  constructor(message = 'device code expired') {
    super(message);
    this.name = 'DeviceCodeExpiredError';
  }
}

export class NetworkError extends AuthError {
  constructor(message = 'network error talking to login.microsoftonline.com') {
    super(message);
    this.name = 'NetworkError';
  }
}

const REFRESH_FAULT_NAMES = new Set([
  'InteractionRequiredAuthError',
  'InteractionRequired',
]);

const CONSENT_DENIED_CODES = new Set([
  'user_cancel',
  'consent_denied',
  'access_denied',
]);

const DEVICE_CODE_EXPIRED_CODES = new Set([
  'code_expired',
  'expired_token',
  'device_code_expired',
]);

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

function isInteractionRequiredFault(error) {
  if (!error) return false;
  if (REFRESH_FAULT_NAMES.has(error.name)) return true;
  if (typeof error.errorCode === 'string' && error.errorCode.includes('interaction_required')) return true;
  return false;
}

function classifyDeviceCodeError(error) {
  if (!error) return new AuthError('unknown MSAL failure');
  const code = typeof error.errorCode === 'string' ? error.errorCode : '';
  if (DEVICE_CODE_EXPIRED_CODES.has(code)) return new DeviceCodeExpiredError();
  if (CONSENT_DENIED_CODES.has(code)) return new ConsentDeniedError();
  if (NETWORK_ERROR_CODES.has(error.code) || NETWORK_ERROR_CODES.has(code)) return new NetworkError();
  return new AuthError('MSAL device-code failure');
}

async function loadCacheFileOrNull(stateDir, profile) {
  const store = createProfileStore({ stateDir });
  return await store.readCache(profile);
}

async function writeCacheFile(stateDir, profile, json) {
  const store = createProfileStore({ stateDir });
  await store.writeCache(profile, json);
}

function extractExpiresAt(cacheJson) {
  if (!cacheJson || typeof cacheJson !== 'object') return null;
  const accessToken = cacheJson.AccessToken;
  if (!accessToken || typeof accessToken !== 'object') return null;
  for (const entry of Object.values(accessToken)) {
    if (!entry || typeof entry !== 'object') continue;
    const expiresAt = entry.expiresOn ?? entry.expiresAt ?? entry.expires_on;
    if (typeof expiresAt === 'string' && expiresAt) return expiresAt;
  }
  return null;
}

export function createFileCachePlugin({ stateDir, profile }) {
  if (typeof profile !== 'string') throw new AuthError('profile id is required');
  validateProfileId(profile);

  return {
    async beforeCacheAccess(tokenCacheContext) {
      const json = await loadCacheFileOrNull(stateDir, profile);
      if (json && json.length > 0) {
        tokenCacheContext.cache.deserialize(json);
      }
    },
    async afterCacheAccess(tokenCacheContext) {
      if (tokenCacheContext.cacheHasChanged) {
        const json = tokenCacheContext.cache.serialize();
        await writeCacheFile(stateDir, profile, json);
      }
    },
  };
}

function buildClient({ profile, stateDir, clientId, tenant, PublicClientApplicationImpl }) {
  const cachePlugin = createFileCachePlugin({ stateDir, profile });
  const app = new (PublicClientApplicationImpl ?? PublicClientApplication)({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenant ?? 'common'}`,
    },
    cache: { cachePlugin },
  });
  return { app, cachePlugin };
}

function normalizeAccessToken(result) {
  if (!result || typeof result.accessToken !== 'string') {
    throw new AuthError('MSAL silent flow returned no access token');
  }
  return {
    accessToken: result.accessToken,
    expiresOn: result.expiresOn ?? null,
    account: result.account ?? null,
  };
}

export function createAuthClient({
  profile,
  stateDir,
  clientId,
  tenant,
  PublicClientApplicationImpl,
} = {}) {
  if (!profile || typeof profile !== 'string') throw new AuthError('profile is required');

  const configuredClientId = typeof clientId === 'string' && clientId.trim()
    ? clientId.trim()
    : typeof process.env.PLANNER_CLIENT_ID === 'string' && process.env.PLANNER_CLIENT_ID.trim()
      ? process.env.PLANNER_CLIENT_ID.trim()
      : BUILTIN_CLIENT_ID;
  const state = {
    profile,
    stateDir: path.resolve(stateDir ?? './planner-state'),
    clientId: configuredClientId,
    tenant: tenant ?? process.env.PLANNER_TENANT ?? 'common',
    PublicClientApplicationImpl: PublicClientApplicationImpl ?? null,
  };
  const built = buildClient(state);

  // MSAL's `acquireTokenByDeviceCode` is a single async call that fires the
  // device-code callback once and then polls until success / expiry / denial.
  // The design's `requestDeviceCode` + `pollForToken` split is a logical
  // separation: we kick the MSAL call once and stash the result promise so
  // both views expose the same underlying operation.
  let pendingDeviceCode = null;

  return {
    profile: state.profile,
    cachePlugin: built.cachePlugin,

    async acquireToken({ scopes, forceRefresh = false }) {
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new AuthError('scopes must be a non-empty array');
      }
      const accounts = await built.app.getAllAccounts();
      if (accounts.length === 0) {
        throw new AuthRequiredError();
      }
      try {
        const result = await built.app.acquireTokenSilent({ account: accounts[0], scopes, forceRefresh: Boolean(forceRefresh) });
        return normalizeAccessToken(result);
      } catch (error) {
        if (isInteractionRequiredFault(error)) {
          throw new AuthError('refresh-failed');
        }
        throw new AuthError('silent refresh failed');
      }
    },

    async requestDeviceCode({ scopes }) {
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new AuthError('scopes must be a non-empty array');
      }
      if (pendingDeviceCode) {
        throw new AuthError('a device code request is already in progress');
      }
      // MSAL's `acquireTokenByDeviceCode` is a single async call that fires
      // the device-code callback once and then polls until success / expiry
      // / denial. We attach the callback, kick the call, and race the
      // callback against the call's eventual settlement so we can return the
      // device code response immediately while the polling continues.
      const slot = {};
      pendingDeviceCode = slot;
      slot.captured = null;
      slot.resultPromise = null;
      let resolveCallback;
      slot.callbackFired = new Promise((resolve) => {
        resolveCallback = resolve;
      });
      let resultPromise;
      try {
        resultPromise = built.app.acquireTokenByDeviceCode({
          scopes,
          deviceCodeCallback: (response) => {
            if (pendingDeviceCode === slot) {
              slot.captured = response;
              resolveCallback();
            }
          },
        });
      } catch (error) {
        pendingDeviceCode = null;
        throw classifyDeviceCodeError(error);
      }
      slot.resultPromise = resultPromise;
      const settled = await Promise.race([
        slot.callbackFired.then(() => ({ kind: 'callback' })),
        resultPromise.then((result) => ({ kind: 'result', result }), (error) => ({ kind: 'error', error })),
      ]);
      if (settled.kind === 'error') {
        pendingDeviceCode = null;
        throw classifyDeviceCodeError(settled.error);
      }
      if (settled.kind === 'result') {
        pendingDeviceCode = null;
        if (slot.captured) {
          return slot.captured;
        }
        throw new AuthError('MSAL did not surface a device code response');
      }
      if (!slot.captured) {
        pendingDeviceCode = null;
        throw new AuthError('MSAL did not surface a device code response');
      }
      return slot.captured;
    },

    async pollForToken({ scopes }) {
      if (!pendingDeviceCode) {
        throw new AuthError('no pending device code request');
      }
      const { resultPromise, captured } = pendingDeviceCode;
      pendingDeviceCode = null;
      try {
        const result = await resultPromise;
        if (!result) throw new AuthError('MSAL device-code flow returned no result');
        return { ...normalizeAccessToken(result), deviceCodeResponse: captured };
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw classifyDeviceCodeError(error);
      }
    },

    async getAllAccounts() {
      return await built.app.getAllAccounts();
    },

    async getStatus() {
      const json = await loadCacheFileOrNull(stateDir, profile);
      if (!json) {
        return { connected: false, expiresAt: null };
      }
      let parsed = null;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new AuthError('invalid token cache JSON');
      }
      const expiresAt = extractExpiresAt(parsed);
      return {
        connected: true,
        expiresAt,
      };
    },

    async close() {
      pendingDeviceCode = null;
      return undefined;
    },
  };
}

// Package-level helpers. login.js is the canonical caller; tests use these
// directly to keep the public surface stable.

export async function readCacheJson({ stateDir, profile }) {
  return await loadCacheFileOrNull(stateDir, profile);
}

export async function writeCacheJson({ stateDir, profile }, json) {
  await writeCacheFile(stateDir, profile, json);
}

export async function requestDeviceCode({ client, scopes }) {
  return await client.requestDeviceCode({ scopes });
}

export async function acquireTokenByDeviceCode({ client, scopes }) {
  if (!client) throw new AuthError('client is required');
  const deviceCodeResponse = await client.requestDeviceCode({ scopes });
  return await client.pollForToken({ scopes });
}
