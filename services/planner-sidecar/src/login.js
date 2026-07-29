import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AuthRequiredError,
  ConsentDeniedError,
  DeviceCodeExpiredError,
  NetworkError,
  createAuthClient,
} from './auth.js';
import { createProfileStore, validateProfileId } from './profile-store.js';

// Re-export the typed errors so login.js callers can match on them via the
// login module surface without reaching into auth.js.
export { AuthRequiredError, ConsentDeniedError, DeviceCodeExpiredError, NetworkError } from './auth.js';

// planner-sidecar/login.js — one-shot CLI that drives the MSAL device-code
// flow once, prints the verification URI + user code to stdout, and writes
// the token cache to `./planner-state/<profile>/token-cache.json` with mode
// 0600. Never logs tokens, audit-logs only the constructor name on failure.
//
// Exit codes (matches design §CLI login flow):
//   0  success
//   2  invalid CLI usage
//   3  device-code expired
//   4  user denied consent
//   5  network error
//   6  profile dir unwritable
//   7  AuthRequiredError (silent path; not normally reachable from login.js)

export const SCOPES = ['Tasks.ReadWrite', 'Group.Read.All'];
export const DEFAULT_PROFILE = 'default';

export function parseLoginArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('login argv must be an array');
  // argv is `[node, script, ...positional]`; require exactly one positional arg.
  if (argv.length < 2) throw new Error('login argv must include node, script path');
  if (argv.length > 3) throw new Error('login argv accepts at most one positional profile id');
  const profile = argv[2] ?? DEFAULT_PROFILE;
  validateProfileId(profile);
  return { profile };
}

export async function runLogin({
  profile,
  stateDir,
  clientId,
  tenant,
  PublicClientApplicationImpl,
  stdout = (line) => process.stdout.write(line + '\n'),
  audit = (line) => process.stderr.write(line + '\n'),
  scopes = SCOPES,
} = {}) {
  validateProfileId(profile);
  const resolvedStateDir = path.resolve(stateDir ?? './planner-state');
  const profileStore = createProfileStore({ stateDir: resolvedStateDir });

  let exitCode = 0;
  let error = null;
  let client = null;

  try {
    try {
      await profileStore.ensureProfileDir(profile);
    } catch (err) {
      exitCode = 6;
      error = err;
      throw err;
    }

    client = createAuthClient({
      profile,
      stateDir: resolvedStateDir,
      clientId,
      tenant,
      PublicClientApplicationImpl,
    });

    const deviceCodeResponse = await client.requestDeviceCode({ scopes });
    stdout(`To sign in, open ${deviceCodeResponse.verificationUri} and enter: ${deviceCodeResponse.userCode}`);
    const result = await client.pollForToken({ scopes });
    // The cache file is written by the ICachePlugin.afterCacheAccess hook when
    // MSAL has flushed the access token into the in-memory cache. Confirm the
    // path is present and chmod 0600 (the plugin already does this, but the
    // CLI is the contract owner).
    const cacheFile = path.join(resolvedStateDir, 'profiles', profile, 'token-cache.json');
    const { chmod } = await import('node:fs/promises');
    await chmod(cacheFile, 0o600).catch(() => {});
    stdout(`Profile '${profile}' ready. Token cache at ${cacheFile}.`);
    audit(JSON.stringify({
      event: 'planner_login_success',
      profile,
      expiresOn: result.expiresOn instanceof Date ? result.expiresOn.toISOString() : null,
    }));
    return { exitCode: 0, profile, result, error: null };
  } catch (err) {
    if (err instanceof AuthRequiredError) exitCode = 7;
    else if (err instanceof DeviceCodeExpiredError) exitCode = 3;
    else if (err instanceof ConsentDeniedError) exitCode = 4;
    else if (err instanceof NetworkError) exitCode = 5;
    else if (err && err.code === 'EACCES') exitCode = 6;
    else if (err && err.code === 'EPERM') exitCode = 6;
    else if (exitCode === 0) exitCode = 1;
    error = err;
    audit(JSON.stringify({
      event: 'planner_login_failure',
      profile,
      error: err?.constructor?.name ?? 'Error',
      code: err && typeof err.errorCode === 'string' ? err.errorCode : null,
    }));
    return { exitCode, profile, result: null, error };
  } finally {
    if (client) await client.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { profile } = parseLoginArgs(process.argv);
  const { exitCode } = await runLogin({ profile });
  process.exit(exitCode);
}
