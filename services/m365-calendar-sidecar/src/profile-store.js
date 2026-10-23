import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// m365-calendar-sidecar stores the MSAL token cache per profile at
// `<stateDir>/profiles/<id>/token-cache.json`. Profiles are isolated: each
// profile owns its own directory and its own cache file, and the profile id
// format is bounded so the path cannot escape the profiles root.
//
// The default state dir is `./calendar-state` (relative to the sidecar
// working directory). The container mounts `./calendar-state` host volume
// onto `/var/lib/m365-calendar`; the layout only relies on the path.
export const DEFAULT_STATE_DIR = path.resolve('./calendar-state');

// Profile ids: lowercase alphanumeric + dash, 1..64 chars. Strictly bounded so
// the resolved path stays under the profiles root and there is no path-traversal
// or shell-danger surface. The container surface only ever produces "default".
const PROFILE_ID_REGEX = /^[a-z0-9-]{1,64}$/;

export class ProfileIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileIdError';
  }
}

export function validateProfileId(id) {
  if (typeof id !== 'string' || !PROFILE_ID_REGEX.test(id)) {
    throw new ProfileIdError(
      'profile id must match /^[a-z0-9-]{1,64}$/ and be a string',
    );
  }
}

function profilesRoot(stateDir) {
  return path.join(path.resolve(stateDir), 'profiles');
}

function profileRoot(stateDir, id) {
  validateProfileId(id);
  const resolved = path.resolve(profilesRoot(stateDir), id);
  const root = path.resolve(profilesRoot(stateDir));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ProfileIdError('profile id must not escape the profiles root');
  }
  return resolved;
}

function cachePath(stateDir, id) {
  return path.join(profileRoot(stateDir, id), 'token-cache.json');
}

export function createProfileStore({ stateDir } = {}) {
  const resolvedStateDir = path.resolve(stateDir ?? DEFAULT_STATE_DIR);

  async function listProfiles() {
    const root = profilesRoot(resolvedStateDir);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => PROFILE_ID_REGEX.test(name))
      .sort();
  }

  async function profileDir(id) {
    return profileRoot(resolvedStateDir, id);
  }

  async function ensureProfileDir(id) {
    const dir = profileRoot(resolvedStateDir, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async function readCache(id) {
    try {
      return await readFile(cachePath(resolvedStateDir, id), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writeCache(id, json) {
    const dir = profileRoot(resolvedStateDir, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(cachePath(resolvedStateDir, id), json, { mode: 0o600 });
  }

  return {
    stateDir: resolvedStateDir,
    listProfiles,
    profileDir,
    ensureProfileDir,
    readCache,
    writeCache,
  };
}

export function defaultProfileStore() {
  return createProfileStore({ stateDir: DEFAULT_STATE_DIR });
}
