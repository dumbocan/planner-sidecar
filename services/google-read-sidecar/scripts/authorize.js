import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, readFile, writeFile } from 'node:fs/promises';

import { resolveAccountPaths } from '../src/google-client.js';
import { validateGrantedScopes } from '../src/tools.js';

const slot = process.argv[2] ?? 'laia';
const secretDir = process.env.GOOGLE_SECRET_DIR ?? '/run/secrets/google-read-only';
const { client: clientPath, token: tokenPath } = resolveAccountPaths(secretDir, slot);
const scopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy',
  ...(slot === 'laia'
    ? [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/contacts',
        'https://www.googleapis.com/auth/contacts.other.readonly',
      ]
    : [
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'https://www.googleapis.com/auth/contacts',
      ]),
];

const client = JSON.parse(await readFile(clientPath, 'utf8')).installed;
if (!client?.client_id) throw new Error(`${clientPath} must contain an installed OAuth client`);

const verifier = randomBytes(64).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(32).toString('base64url');
const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const { port } = listener.address();
const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authorizeUrl.search = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: scopes.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
}).toString();

console.log(`Authorizing Google account slot="${slot}" via browser PKCE loopback.`);
console.log('Open this URL in a browser on this Docker host, then approve only the scopes listed above:');
console.log(authorizeUrl.toString());

const code = await new Promise((resolve, reject) => {
  listener.once('request', (request, response) => {
    const callback = new URL(request.url, redirectUri);
    if (callback.pathname !== '/oauth2/callback' || callback.searchParams.get('state') !== state) {
      response.writeHead(400).end('Authorization failed. Return to the terminal.');
      reject(new Error('OAuth callback state validation failed'));
      return;
    }
    const value = callback.searchParams.get('code');
    if (!value) {
      response.writeHead(400).end('Authorization failed. Return to the terminal.');
      reject(new Error(callback.searchParams.get('error') ?? 'OAuth authorization was denied'));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end('Authorization completed. You may close this tab.');
    resolve(value);
  });
});

try {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error('OAuth token exchange failed');
  const token = await response.json();
  validateGrantedScopes(token.scope);
  if (!token.refresh_token) throw new Error('OAuth response did not include a refresh token');
  await writeFile(tokenPath, `${JSON.stringify({ refresh_token: token.refresh_token, scope: token.scope })}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  console.log(`Authorization completed for slot="${slot}". The refresh token was saved only in the sidecar secret directory.`);
} finally {
  listener.close();
}