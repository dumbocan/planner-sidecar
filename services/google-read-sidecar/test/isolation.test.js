import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const composePath = new URL('../../../docker-compose2.yml', import.meta.url);

test('only the Google sidecar receives the OAuth secret mount', async () => {
  const compose = await readFile(composePath, 'utf8');
  const secretMount = './google-secrets:/run/secrets/google-read-only:ro';
  assert.match(compose, new RegExp(`google-read-sidecar:[\\s\\S]*${secretMount.replaceAll('/', '\\/')}`));
  for (const service of ['openclaw-gateway', 'openclaw-cli']) {
    const section = compose.split(`  ${service}:`)[1].split('\n  ')[0];
    assert.equal(section.includes('/run/secrets/google-read-only'), false);
  }
});

test('the sidecar is not published on a host port and is filtered to read tools', async () => {
  const compose = await readFile(composePath, 'utf8');
  const sidecar = compose.split('  google-read-sidecar:')[1].split('\nnetworks:')[0];
  assert.equal(sidecar.includes('ports:'), false);
  assert.match(sidecar, /google-mcp-internal/);
  assert.match(sidecar, /google-egress/);
  const config = JSON.parse(await readFile(new URL('../../../state/openclaw.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.mcp.servers['google-read'].toolFilter.include, [
    'gmail_search',
    'gmail_get_sanitized',
    'gmail_extract_pdf_attachment',
    'calendar_freebusy',
    'calendar_list_events',
    'calendar_create_event',
    'calendar_update_event',
    'calendar_delete_event',
    'contacts_search',
    'contacts_get',
    'contacts_create',
    'contacts_update',
  ]);
});
