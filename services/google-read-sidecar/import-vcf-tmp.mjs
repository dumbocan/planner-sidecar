// Import a VCF file (at /dev/shm/contacts.vcf) into Laia's Google account via People API.

import { readFile } from 'node:fs/promises';
import { google } from 'googleapis';

const SECRET_DIR = '/run/secrets/google-read-only';
const VCF_PATH = process.argv[2] ?? '/dev/shm/contacts.vcf';

const clientJson = JSON.parse(await readFile(`${SECRET_DIR}/desktop-client.json`, 'utf8'));
const tokenJson = JSON.parse(await readFile(`${SECRET_DIR}/token.json`, 'utf8'));
const oauth = new google.auth.OAuth2(
  clientJson.installed.client_id,
  clientJson.installed.client_secret,
  clientJson.installed.redirect_uris[0],
);
oauth.setCredentials({ refresh_token: tokenJson.refresh_token });
const people = google.people({ version: 'v1', auth: oauth });

const vcfText = await readFile(VCF_PATH, 'utf8');

function parseVcards(text) {
  const blocks = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === 'BEGIN:VCARD') current = { lines: [] };
    else if (line === 'END:VCARD') {
      if (current) blocks.push(current);
      current = null;
    } else if (current) current.lines.push(line);
  }
  return blocks;
}

function unescape(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function getProp(lines, name) {
  for (const line of lines) {
    if (line.startsWith(name + ':') || line.startsWith(name + ';')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx >= 0) return unescape(line.slice(colonIdx + 1));
    }
  }
  return null;
}

function getProps(lines, name) {
  const out = [];
  for (const line of lines) {
    if (line.startsWith(name + ':') || line.startsWith(name + ';')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx >= 0) out.push(unescape(line.slice(colonIdx + 1)));
    }
  }
  return out;
}

function parseVcard({ lines }) {
  const fn = getProp(lines, 'FN');
  const n = getProp(lines, 'N');
  const emails = getProps(lines, 'EMAIL').map((v) => ({ value: v }));
  const tels = getProps(lines, 'TEL').map((v) => ({ value: v }));
  const orgFull = getProp(lines, 'ORG');
  const org = orgFull ? orgFull.split(';')[0] : null;
  const title = getProp(lines, 'TITLE');
  const urls = getProps(lines, 'URL').map((v) => ({ value: v }));
  const bday = getProp(lines, 'BDAY');

  const givenName = n ? (n.split(';')[1] ?? '') : '';
  const familyName = n ? (n.split(';')[0] ?? '') : '';
  const displayName = fn ?? '';

  if (!givenName && !familyName && !displayName && emails.length === 0 && tels.length === 0) {
    return null;
  }

  return {
    names: [{
      ...(givenName ? { givenName } : {}),
      ...(familyName ? { familyName } : {}),
      ...(displayName ? { displayName } : {}),
    }],
    ...(emails.length ? { emailAddresses: emails } : {}),
    ...(tels.length ? { phoneNumbers: tels } : {}),
    ...(org ? { organizations: [{ name: org, ...(title ? { title } : {}) }] } : {}),
    ...(urls.length ? { urls } : {}),
    ...(bday ? { birthdays: [{ date: bday }] } : {}),
  };
}

const cards = parseVcards(vcfText).map(parseVcard).filter(Boolean);
console.log(`parsed ${cards.length} contacts from VCF`);

let ok = 0;
let fail = 0;
const failures = [];
for (let i = 0; i < cards.length; i++) {
  const body = cards[i];
  try {
    await people.people.createContact({ requestBody: body });
    ok++;
  } catch (e) {
    fail++;
    failures.push({ index: i, name: body.names?.[0]?.displayName ?? '<unknown>', code: e.code, msg: e.message?.slice(0, 120) });
  }
  if ((i + 1) % 25 === 0) console.log(`progress: ${i + 1}/${cards.length} (ok=${ok}, fail=${fail})`);
}
console.log(`DONE. ok=${ok}, fail=${fail}`);
if (failures.length) console.log(JSON.stringify(failures.slice(0, 10), null, 2));