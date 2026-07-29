import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

import { validateGrantedScopes } from './tools.js';

const SECRET_DIR = '/run/secrets/google-read-only';
const ACCOUNT_CREDENTIALS = {
  laia: { clientFile: 'desktop-client.json', tokenFile: 'token.json' },
  personal: { clientFile: 'gmail-dumbo-cata-desktop-client.json', tokenFile: 'gmail-dumbo-cata-token.json' },
};

export function resolveCredentialPaths(secretDir = process.env.GOOGLE_SECRET_DIR ?? SECRET_DIR) {
  if (path.resolve(secretDir) !== SECRET_DIR) throw new Error('GOOGLE_SECRET_DIR must use the sidecar-only secret mount');
  return secretDir;
}

export function resolveAccountPaths(secretDir, account) {
  const cred = ACCOUNT_CREDENTIALS[account];
  if (!cred) throw new Error(`Unknown account: ${account}. Valid: ${Object.keys(ACCOUNT_CREDENTIALS).join(', ')}`);
  return {
    client: path.join(secretDir, cred.clientFile),
    token: path.join(secretDir, cred.tokenFile),
  };
}

async function initSingleAccount(secretDir, account) {
  const paths = resolveAccountPaths(secretDir, account);
  const [clientJson, tokenJson] = await Promise.all([
    readFile(paths.client, 'utf8'),
    readFile(paths.token, 'utf8'),
  ]);
  const client = JSON.parse(clientJson).installed;
  const token = JSON.parse(tokenJson);
  if (!client?.client_id || !client?.redirect_uris?.length || !token?.refresh_token) {
    throw new Error(`Google authorization is incomplete for account "${account}"`);
  }
  validateGrantedScopes(token.scope);
  const oauth = new google.auth.OAuth2(client.client_id, client.client_secret, client.redirect_uris[0]);
  oauth.setCredentials({ refresh_token: token.refresh_token });
  const accessToken = await oauth.getAccessToken();
  if (!accessToken.token) throw new Error(`Google access token refresh failed for account "${account}"`);
  const tokenInfo = await oauth.getTokenInfo(accessToken.token);
  validateGrantedScopes(tokenInfo.scopes);
  return {
    gmail: google.gmail({ version: 'v1', auth: oauth }),
    calendar: google.calendar({ version: 'v3', auth: oauth }),
    people: google.people({ version: 'v1', auth: oauth }),
  };
}

export async function createGoogleClients() {
  const secretDir = resolveCredentialPaths();
  const [laia, personal] = await Promise.allSettled([
    initSingleAccount(secretDir, 'laia'),
    initSingleAccount(secretDir, 'personal'),
  ]);
  const accounts = {};
  if (laia.status === 'fulfilled') accounts.laia = laia.value;
  else console.error('Failed to initialize account "laia":', laia.reason?.message ?? laia.reason);

  if (personal.status === 'fulfilled') accounts.personal = personal.value;
  else console.error('Failed to initialize account "personal":', personal.reason?.message ?? personal.reason);

  if (!accounts.laia) throw new Error('Primary account "laia" failed to initialize');
  return accounts;
}
