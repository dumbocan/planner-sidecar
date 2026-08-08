#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLogin } from './login.js';
import { validateProfileId } from './profile-store.js';
import { listen } from './server.js';

const VERSION = '0.2.0';
const DEFAULT_PROFILE = 'default';
const DEFAULT_PORT = 3000;
const USAGE = `Usage:
  planner-sidecar onboard [profile]
  planner-sidecar serve
  planner-sidecar --help
  planner-sidecar --version`;

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('CLI argv must be an array');
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { command: 'help' };
  if (argv.length === 1 && argv[0] === '--version') return { command: 'version', version: VERSION };
  if (argv[0] === 'onboard' && argv.length <= 2) {
    const profile = argv[1] ?? DEFAULT_PROFILE;
    try {
      validateProfileId(profile);
      return { command: 'onboard', profile };
    } catch {
      return { command: 'help', unknown: true };
    }
  }
  if (argv.length === 1 && argv[0] === 'serve') return { command: 'serve' };
  return { command: 'help', unknown: true };
}

export async function main(argv = process.argv.slice(2), {
  env = process.env,
  runLoginImpl = runLogin,
  listenImpl = listen,
  mkdirImpl = mkdir,
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.command === 'help') {
    (parsed.unknown ? stderr : stdout)(USAGE);
    return parsed.unknown ? 2 : 0;
  }
  if (parsed.command === 'version') {
    stdout(parsed.version);
    return 0;
  }

  const stateDir = path.resolve(env.PLANNER_STATE_DIR ?? './planner-state');
  try {
    await mkdirImpl(stateDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    const guidance = error?.code === 'EACCES' || error?.code === 'EPERM'
      ? ' Check ownership of planner-state (for Docker mounts: chown 1000:1000 planner-state/).'
      : '';
    stderr(`Planner state directory is unavailable.${guidance}`);
    return 1;
  }

  if (parsed.command === 'onboard') {
    const result = await runLoginImpl({
      profile: parsed.profile,
      stateDir,
      clientId: env.PLANNER_CLIENT_ID,
      tenant: env.PLANNER_TENANT,
    });
    if (result.exitCode === 5) {
      stderr('Cannot reach login.microsoftonline.com. Check the network and try again.');
    }
    return result.exitCode;
  }

  try {
    const handle = await listenImpl(Number(env.PORT ?? DEFAULT_PORT));
    stderr(`Planner sidecar listening on 0.0.0.0:${handle.port}`);
    return 0;
  } catch (error) {
    stderr(`Planner sidecar failed to start (${error?.constructor?.name ?? 'Error'}).`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
