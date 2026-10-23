import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createProfileStore,
  defaultProfileStore,
  validateProfileId,
} from '../src/profile-store.js';

async function makeTempStateDir() {
  const root = await mkdtemp(path.join(tmpdir(), 'm365-calendar-profile-store-'));
  return root;
}

test('defaultProfileStore roots under ./calendar-state by default', () => {
  const store = defaultProfileStore();
  assert.equal(store.stateDir, path.resolve('./calendar-state'));
});

test('validateProfileId accepts the documented lower-case alphanumeric+dash profile ids', () => {
  for (const value of ['default', 'a', 'work-123', 'a-b-c-d-e']) {
    assert.doesNotThrow(() => validateProfileId(value));
  }
});

test('validateProfileId rejects path traversal, slash, backslash, empty, uppercase, control bytes, and oversize ids', () => {
  for (const value of [
    '',
    '..',
    '../default',
    'foo/../bar',
    'foo/bar',
    'foo\\bar',
    'Default',
    'DEFAULT',
    'has space',
    'has\u0000byte',
    'has\nnewline',
    'a'.repeat(65),
    'name_with_underscore',
    'name.with.dot',
    'name+plus',
  ]) {
    assert.throws(() => validateProfileId(value), /profile id/i, `must reject ${JSON.stringify(value)}`);
  }
});

test('validateProfileId rejects non-string inputs without throwing TypeError', () => {
  for (const value of [null, undefined, 42, true, {}, [], Buffer.from('default')]) {
    assert.throws(() => validateProfileId(value), /profile id/i);
  }
});

test('createProfileStore({stateDir}) returns a store rooted at the given dir', () => {
  const store = createProfileStore({ stateDir: '/tmp/example' });
  assert.equal(store.stateDir, path.resolve('/tmp/example'));
});

test('listProfiles returns profile ids found under profiles/ and ignores everything else', async () => {
  const stateDir = await makeTempStateDir();
  const store = createProfileStore({ stateDir });
  await mkdir(path.join(stateDir, 'profiles', 'default'), { recursive: true });
  await mkdir(path.join(stateDir, 'profiles', 'work'), { recursive: true });
  await mkdir(path.join(stateDir, 'profiles', 'Default'), { recursive: true });
  await writeFile(path.join(stateDir, 'profiles', 'README.md'), 'ignore');
  await writeFile(path.join(stateDir, 'profiles', 'work.json'), 'ignore');
  const ids = (await store.listProfiles()).sort();
  assert.deepEqual(ids, ['default', 'work']);
  await rm(stateDir, { recursive: true, force: true });
});

test('listProfiles returns [] when the profiles dir does not exist', async () => {
  const stateDir = await makeTempStateDir();
  const store = createProfileStore({ stateDir });
  assert.deepEqual(await store.listProfiles(), []);
  await rm(stateDir, { recursive: true, force: true });
});

test('profileDir returns the per-profile directory under the profiles root', async () => {
  const stateDir = await makeTempStateDir();
  const store = createProfileStore({ stateDir });
  const dir = await store.profileDir('default');
  assert.equal(dir, path.join(path.resolve(stateDir), 'profiles', 'default'));
  await rm(stateDir, { recursive: true, force: true });
});

test('ensureProfileDir creates the per-profile directory with mode 0700', async (t) => {
  const stateDir = await makeTempStateDir();
  const store = createProfileStore({ stateDir });
  const dir = await store.ensureProfileDir('default');
  assert.equal(dir, path.join(path.resolve(stateDir), 'profiles', 'default'));
  const info = await stat(dir);
  assert.equal(info.isDirectory(), true);
  const mode = info.mode & 0o777;
  assert.equal(mode & 0o700, 0o700, `mode 0700 owner bits expected, got ${mode.toString(8)}`);
  t.diagnostic(`profile dir mode=${mode.toString(8)}`);
  await rm(stateDir, { recursive: true, force: true });
});

test('ensureProfileDir refuses to escape the profiles root', async (t) => {
  const stateDir = await makeTempStateDir();
  const store = createProfileStore({ stateDir });
  for (const bad of ['..', 'foo/bar', 'foo\\bar', '../escape']) {
    await assert.rejects(() => store.ensureProfileDir(bad), /profile id/i, `must reject ${bad}`);
  }
  t.diagnostic('path traversal rejected at validation');
  await rm(stateDir, { recursive: true, force: true });
});

test('ensureProfileDir is idempotent', async () => {
  const stateDir = await makeTempStateDir();
  const store = createProfileStore({ stateDir });
  const first = await store.ensureProfileDir('default');
  const second = await store.ensureProfileDir('default');
  assert.equal(first, second);
  const entries = await readdir(path.join(path.resolve(stateDir), 'profiles'));
  assert.deepEqual(entries, ['default']);
  await rm(stateDir, { recursive: true, force: true });
});

test('readCache returns null when the cache file is absent for a valid profile', async () => {
  const stateDir = await makeTempStateDir();
  const store = createProfileStore({ stateDir });
  await store.ensureProfileDir('default');
  assert.equal(await store.readCache('default'), null);
  await rm(stateDir, { recursive: true, force: true });
});

test('writeCache stores the cache JSON in the profile dir', async () => {
  const stateDir = await makeTempStateDir();
  const store = createProfileStore({ stateDir });
  await store.ensureProfileDir('default');
  await store.writeCache('default', '{"AccessToken":{}}');
  const raw = await store.readCache('default');
  assert.equal(raw, '{"AccessToken":{}}');
  await rm(stateDir, { recursive: true, force: true });
});
