import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_SCOPES,
  TOOL_NAMES,
  createReadTools,
  validateGrantedScopes,
} from '../src/tools.js';

function mockAccounts({ gmail = {}, calendar = {}, people = {} } = {}) {
  return {
    laia: { gmail, calendar, people },
    personal: { gmail, calendar, people },
  };
}

test('accepts exactly the approved Google scopes', () => {
  assert.deepEqual(
    validateGrantedScopes([...ALLOWED_SCOPES]),
    new Set(ALLOWED_SCOPES),
  );
});

test('rejects a token with Gmail send or Calendar acl authority', () => {
  assert.throws(
    () => validateGrantedScopes([...ALLOWED_SCOPES, 'https://www.googleapis.com/auth/gmail.send']),
    /forbidden scope/,
  );
  assert.throws(
    () => validateGrantedScopes([...ALLOWED_SCOPES, 'https://www.googleapis.com/auth/calendar.acl']),
    /forbidden scope/,
  );
});

test('accepts a token with the new calendar.events scope', () => {
  assert.doesNotThrow(() => validateGrantedScopes([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.freebusy',
    'https://www.googleapis.com/auth/calendar.events',
  ]));
  assert.doesNotThrow(() => validateGrantedScopes([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.freebusy',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ]));
});

test('accepts a token with the new contacts scopes for either slot', () => {
  assert.doesNotThrow(() => validateGrantedScopes([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.freebusy',
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/contacts.other.readonly',
  ]));
  assert.doesNotThrow(() => validateGrantedScopes([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.freebusy',
    'https://www.googleapis.com/auth/contacts.readonly',
  ]));
});

test('rejects the contacts.other write scope (only .readonly is allowed)', () => {
  assert.throws(
    () => validateGrantedScopes([...ALLOWED_SCOPES, 'https://www.googleapis.com/auth/contacts.other']),
    /forbidden scope/,
  );
});

test('gmail search uses an explicit bound and redacts output', async () => {
  const requests = [];
  const tools = createReadTools(mockAccounts({
    gmail: {
      users: {
        messages: {
          async list(request) {
            requests.push(request);
            return { data: { messages: [{ id: 'message-1', threadId: 'thread-1' }] } };
          },
          async get() {
            return {
              data: {
                id: 'message-1',
                threadId: 'thread-1',
                payload: {
                  headers: [
                    { name: 'From', value: 'Sender <sender@example.com>' },
                    { name: 'Subject', value: 'Call me at 555-123-4567' },
                    { name: 'Date', value: 'Mon, 1 Jan 2026 10:00:00 +0000' },
                  ],
                },
                snippet: 'Reply at https://private.example.test/secret',
              },
            };
          },
        },
      },
    },
    calendar: { freebusy: { async query() { throw new Error('not used'); } } },
  }));

  const result = await tools.gmailSearch({ query: 'from:sender', maxResults: 99 });

  assert.equal(requests[0].maxResults, 20);
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].from, /\[redacted-email\]/);
  assert.match(result.messages[0].subject, /\[redacted-phone\]/);
  assert.match(result.messages[0].snippet, /\[redacted-url\]/);
});

test('gmail get returns a bounded sanitized excerpt instead of raw MIME data', async () => {
  const tools = createReadTools(mockAccounts({
    gmail: {
      users: {
        messages: {
          async get() {
            return {
              data: {
                id: 'message-1',
                threadId: 'thread-1',
                payload: {
                  headers: [{ name: 'Subject', value: 'Private' }],
                  mimeType: 'text/plain',
                  body: { data: Buffer.from('x'.repeat(3000)).toString('base64url') },
                },
              },
            };
          },
        },
      },
    },
    calendar: { freebusy: { async query() { throw new Error('not used'); } } },
  }));

  const result = await tools.gmailGetSanitized({ messageId: 'message-1', maxChars: 5000 });

  assert.equal(result.excerpt.length, 2000);
  assert.equal(Object.hasOwn(result, 'raw'), false);
});

test('freebusy validates an RFC3339 interval before calling Google', async () => {
  let calls = 0;
  const tools = createReadTools(mockAccounts({
    gmail: { users: { messages: {} } },
    calendar: {
      freebusy: {
        async query() {
          calls += 1;
          return { data: {} };
        },
      },
    },
  }));

  await assert.rejects(
    () => tools.calendarFreebusy({ timeMin: '2026-01-02T10:00:00Z', timeMax: '2026-01-01T10:00:00Z' }),
    /after timeMin/,
  );
  assert.equal(calls, 0);
});

test('calendar list events accepts both accounts and forwards to calendar.events.list', async () => {
  const seen = [];
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {
        freebusy: {},
        events: {
          async list(request) {
            seen.push({ account: 'laia', calendarId: request.calendarId, maxResults: request.maxResults });
            return { data: { items: [{ id: 'event-laia' }] } };
          },
        },
      },
    },
    personal: {
      gmail: {},
      calendar: {
        freebusy: {},
        events: {
          async list(request) {
            seen.push({ account: 'personal', calendarId: request.calendarId, maxResults: request.maxResults });
            return { data: { items: [{ id: 'event-personal' }] } };
          },
        },
      },
    },
  });

  const laiaResult = await tools.calendarListEvents({
    calendarId: 'primary',
    timeMin: '2026-01-01T00:00:00Z',
    timeMax: '2026-02-01T00:00:00Z',
    account: 'laia',
  });
  const personalResult = await tools.calendarListEvents({
    calendarId: 'primary',
    timeMin: '2026-01-01T00:00:00Z',
    timeMax: '2026-02-01T00:00:00Z',
    account: 'personal',
  });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].account, 'laia');
  assert.equal(seen[1].account, 'personal');
  assert.equal(seen[0].calendarId, 'primary');
  assert.equal(seen[0].maxResults, 25);
  assert.equal(laiaResult.events[0].id, 'event-laia');
  assert.equal(personalResult.events[0].id, 'event-personal');
});

test('calendar write tools reject account="personal" with the laia-only error', async () => {
  const makeEvents = () => ({
    async insert() { throw new Error('insert should not be called for account=personal'); },
    async patch() { throw new Error('patch should not be called for account=personal'); },
    async delete() { throw new Error('delete should not be called for account=personal'); },
  });
  const tools = createReadTools({
    laia: { gmail: {}, calendar: { events: makeEvents() } },
    personal: { gmail: {}, calendar: { events: makeEvents() } },
  });

  await assert.rejects(
    () => tools.calendarCreateEvent({
      calendarId: 'primary',
      summary: 'Test event',
      start: { dateTime: '2026-01-01T10:00:00Z', timeZone: 'UTC' },
      end: { dateTime: '2026-01-01T11:00:00Z', timeZone: 'UTC' },
      account: 'personal',
    }),
    /write operations require the laia account/,
  );

  await assert.rejects(
    () => tools.calendarUpdateEvent({
      calendarId: 'primary',
      eventId: 'event-1',
      summary: 'Updated',
      account: 'personal',
    }),
    /write operations require the laia account/,
  );

  await assert.rejects(
    () => tools.calendarDeleteEvent({
      calendarId: 'primary',
      eventId: 'event-1',
      account: 'personal',
    }),
    /write operations require the laia account/,
  );
});

test('calendar create event forwards to calendar.events.insert on the laia account', async () => {
  let captured;
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {
        events: {
          async insert(request) {
            captured = request;
            return {
              data: {
                id: 'created-event-1',
                summary: 'New event',
                start: { dateTime: '2026-02-01T10:00:00Z' },
                end: { dateTime: '2026-02-01T11:00:00Z' },
                attendees: [{ email: 'guest@example.com' }],
              },
            };
          },
          async patch() { throw new Error('not used'); },
          async delete() { throw new Error('not used'); },
        },
      },
    },
    personal: { gmail: {}, calendar: { events: { async insert() { throw new Error('personal insert should not be called'); } } } },
  });

  const result = await tools.calendarCreateEvent({
    calendarId: 'primary',
    summary: 'New event',
    description: 'Plan',
    start: { dateTime: '2026-02-01T10:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-02-01T11:00:00Z', timeZone: 'UTC' },
    attendees: ['guest@example.com'],
    account: 'laia',
  });

  assert.equal(captured.calendarId, 'primary');
  assert.equal(captured.requestBody.summary, 'New event');
  assert.equal(captured.requestBody.attendees[0].email, 'guest@example.com');
  assert.equal(result.id, 'created-event-1');
});

test('calendar update and delete forward to calendar.events.patch and delete on the laia account', async () => {
  const calls = [];
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {
        events: {
          async patch(request) {
            calls.push({ method: 'patch', request });
            return { data: { id: request.eventId, summary: request.requestBody.summary } };
          },
          async delete(request) {
            calls.push({ method: 'delete', request });
            return { data: {} };
          },
          async insert() { throw new Error('not used'); },
        },
      },
    },
    personal: { gmail: {}, calendar: { events: {} } },
  });

  await tools.calendarUpdateEvent({
    calendarId: 'primary',
    eventId: 'event-1',
    summary: 'Updated title',
    account: 'laia',
  });
  await tools.calendarDeleteEvent({ calendarId: 'primary', eventId: 'event-1', account: 'laia' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'patch');
  assert.equal(calls[0].request.eventId, 'event-1');
  assert.equal(calls[0].request.requestBody.summary, 'Updated title');
  assert.equal(calls[1].method, 'delete');
  assert.equal(calls[1].request.calendarId, 'primary');
  assert.equal(calls[1].request.eventId, 'event-1');
});

test('exports the eleven canonical tool names in canonical order', () => {
  assert.deepEqual(TOOL_NAMES, [
    'gmail_search',
    'gmail_get_sanitized',
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

test('calendar events returned by every tool are sanitized like Gmail excerpts', async () => {
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {
        events: {
          async list() {
            return {
              data: {
                items: [
                  {
                    id: 'event-with-leaks',
                    summary: 'Meet at https://private.example.test/secret',
                    description: 'Contact me at leaked@example.com or +1 (555) 123-4567',
                    location: 'Office',
                    attendees: [
                      { email: 'guest@example.com' },
                      { email: 'spy@example.com' },
                    ],
                    start: { dateTime: '2026-02-01T10:00:00Z' },
                    end: { dateTime: '2026-02-01T11:00:00Z' },
                  },
                ],
              },
            };
          },
          async insert() {
            return {
              data: {
                id: 'created-event',
                summary: 'Call sent from https://private.example.test/login',
                description: 'Reply to leaked@example.com',
                attendees: [{ email: 'guest@example.com' }],
                start: { dateTime: '2026-02-01T10:00:00Z' },
                end: { dateTime: '2026-02-01T11:00:00Z' },
              },
            };
          },
          async patch() {
            return {
              data: {
                id: 'patched-event',
                summary: 'Patched at https://private.example.test/m',
                description: 'Email patched@example.com',
                attendees: [{ email: 'guest@example.com' }],
                start: { dateTime: '2026-02-01T10:00:00Z' },
                end: { dateTime: '2026-02-01T11:00:00Z' },
              },
            };
          },
          async delete() { return { data: {} }; },
        },
      },
    },
    personal: { gmail: {}, calendar: { events: { async list() { return { data: { items: [] } }; } } } },
  });

  const list = await tools.calendarListEvents({
    calendarId: 'primary',
    timeMin: '2026-02-01T00:00:00Z',
    timeMax: '2026-02-02T00:00:00Z',
    account: 'laia',
  });
  const listed = list.events[0];
  assert.match(listed.summary, /\[redacted-url\]/);
  assert.doesNotMatch(listed.summary, /https:\/\/private\.example\.test/);
  assert.match(listed.description, /\[redacted-email\]/);
  assert.match(listed.description, /\[redacted-phone\]/);
  assert.doesNotMatch(listed.description, /leaked@example\.com/);
  assert.equal(listed.location, 'Office');
  assert.equal(listed.attendees.length, 2);
  for (const attendee of listed.attendees) {
    assert.match(attendee.email, /\[redacted-email\]/);
    assert.equal(attendee.email.includes('@example.com'), false);
  }

  const created = await tools.calendarCreateEvent({
    calendarId: 'primary',
    summary: 'Bootstrap',
    start: { dateTime: '2026-02-01T10:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-02-01T11:00:00Z', timeZone: 'UTC' },
    account: 'laia',
  });
  assert.match(created.summary, /\[redacted-url\]/);
  assert.match(created.description, /\[redacted-email\]/);
  assert.equal(created.attendees[0].email.includes('@example.com'), false);

  const patched = await tools.calendarUpdateEvent({
    calendarId: 'primary',
    eventId: 'event-1',
    summary: 'Patch',
    account: 'laia',
  });
  assert.match(patched.summary, /\[redacted-url\]/);
  assert.match(patched.description, /\[redacted-email\]/);
});

test('contacts_search accepts both accounts and forwards to people.people.searchContacts', async () => {
  const seen = [];
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async searchContacts(request) {
            seen.push({ account: 'laia', query: request.query, pageSize: request.pageSize, readMask: request.readMask });
            return {
              data: {
                results: [
                  {
                    person: {
                      resourceName: 'people/c1',
                      etag: 'etag-1',
                      names: [{ displayName: 'Alice Smith', givenName: 'Alice', familyName: 'Smith' }],
                      emailAddresses: [{ value: 'alice@example.com', type: 'work' }],
                      phoneNumbers: [{ value: '+15551234567', type: 'mobile' }],
                      organizations: [{ name: 'Acme Corp' }],
                    },
                  },
                ],
              },
            };
          },
        },
      },
    },
    personal: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async searchContacts(request) {
            seen.push({ account: 'personal', query: request.query, pageSize: request.pageSize, readMask: request.readMask });
            return { data: { results: [] } };
          },
        },
      },
    },
  });

  const laiaResult = await tools.contactsSearch({ query: 'alice', maxResults: 50, readMask: 'names,emailAddresses', account: 'laia' });
  const personalResult = await tools.contactsSearch({ query: 'bob', account: 'personal' });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].account, 'laia');
  assert.equal(seen[0].query, 'alice');
  assert.equal(seen[0].pageSize, 50);
  assert.equal(seen[0].readMask, 'names,emailAddresses');
  assert.equal(laiaResult.count, 1);
  assert.equal(laiaResult.contacts[0].displayName, 'Alice Smith');
  assert.equal(laiaResult.contacts[0].givenName, 'Alice');
  assert.equal(laiaResult.contacts[0].familyName, 'Smith');
  assert.equal(personalResult.count, 0);
  assert.deepEqual(personalResult.contacts, []);
});

test('contacts_get validates resourceName as people/... shape and redacts output', async () => {
  const calls = [];
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async get(request) {
            calls.push(request);
            return {
              data: {
                resourceName: 'people/c1',
                etag: 'etag-1',
                names: [{ displayName: 'Visit https://private.example.test/alice for more', givenName: 'Alice', familyName: 'Smith' }],
                emailAddresses: [{ value: 'alice@example.com', type: 'work' }],
                phoneNumbers: [{ value: '+1 (555) 123-4567', type: 'mobile' }],
                organizations: [{ name: 'Acme Corp' }],
                urls: [{ value: 'https://example.com/alice' }],
              },
            };
          },
        },
      },
    },
    personal: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async get() { throw new Error('not used'); },
        },
      },
    },
  });

  await assert.rejects(
    () => tools.contactsGet({ resourceName: 'not-people-prefix' }),
    /resourceName must start with "people\/"/,
  );
  await assert.rejects(
    () => tools.contactsGet({ resourceName: '' }),
    /resourceName must be a string/,
  );

  const result = await tools.contactsGet({ resourceName: 'people/c1', personFields: 'names,emailAddresses,phoneNumbers,organizations,urls' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].resourceName, 'people/c1');
  assert.equal(calls[0].personFields, 'names,emailAddresses,phoneNumbers,organizations,urls');
  assert.equal(result.resourceName, 'people/c1');
  assert.equal(result.displayName.includes('https://private.example.test'), false);
  assert.match(result.displayName, /\[redacted-url\]/);
  assert.equal(result.givenName, 'Alice');
  assert.equal(result.familyName, 'Smith');
  assert.equal(result.organization, 'Acme Corp');
  assert.match(result.emailAddresses[0].value, /\[redacted-email\]/);
  assert.equal(result.emailAddresses[0].value.includes('alice@example.com'), false);
  assert.match(result.phoneNumbers[0].value, /\[redacted-phone\]/);
  assert.equal(result.phoneNumbers[0].value.includes('555'), false);
  assert.match(result.urls[0].value, /\[redacted-url\]/);
});

test('contacts_create and contacts_update reject account="personal" with the laia-only error', async () => {
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async createContact() { throw new Error('createContact should not be called for account=personal'); },
          async updateContact() { throw new Error('updateContact should not be called for account=personal'); },
        },
      },
    },
    personal: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async createContact() { throw new Error('createContact should not be called for account=personal'); },
          async updateContact() { throw new Error('updateContact should not be called for account=personal'); },
        },
      },
    },
  });

  await assert.rejects(
    () => tools.contactsCreate({ displayName: 'Alice', account: 'personal' }),
    /write operations require the laia account/,
  );
  await assert.rejects(
    () => tools.contactsUpdate({ resourceName: 'people/c1', etag: 'e1', displayName: 'Bob', account: 'personal' }),
    /write operations require the laia account/,
  );
});

test('contacts_create forwards nested People API payload to people.people.createContact on the laia account', async () => {
  let captured;
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async createContact(request) {
            captured = request;
            return {
              data: {
                resourceName: 'people/c123',
                etag: 'etag-new',
                names: [{ displayName: 'Alice Smith', givenName: 'Alice', familyName: 'Smith' }],
                emailAddresses: [{ value: 'alice@example.com', type: 'work' }],
                phoneNumbers: [{ value: '+15551234567', type: 'mobile' }],
                organizations: [{ name: 'Acme' }],
              },
            };
          },
          async updateContact() { throw new Error('not used'); },
        },
      },
    },
    personal: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async createContact() { throw new Error('personal createContact should not be called'); },
          async updateContact() { throw new Error('not used'); },
        },
      },
    },
  });

  const result = await tools.contactsCreate({
    displayName: 'Alice Smith',
    givenName: 'Alice',
    familyName: 'Smith',
    emailAddresses: ['alice@example.com'],
    phoneNumbers: ['+15551234567'],
    organization: 'Acme',
    account: 'laia',
  });

  assert.equal(captured.requestBody.names[0].displayName, 'Alice Smith');
  assert.equal(captured.requestBody.names[0].givenName, 'Alice');
  assert.equal(captured.requestBody.names[0].familyName, 'Smith');
  assert.equal(captured.requestBody.emailAddresses[0].value, 'alice@example.com');
  assert.equal(captured.requestBody.phoneNumbers[0].value, '+15551234567');
  assert.equal(captured.requestBody.organizations[0].name, 'Acme');
  assert.equal(result.resourceName, 'people/c123');
  assert.equal(result.displayName, 'Alice Smith');
});

test('contacts_create rejects empty payloads and bad email shapes', async () => {
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async createContact() { throw new Error('createContact should not be called'); },
          async updateContact() { throw new Error('not used'); },
        },
      },
    },
    personal: { gmail: {}, calendar: {}, people: { people: {} } },
  });

  await assert.rejects(
    () => tools.contactsCreate({ account: 'laia' }),
    /at least one of/,
  );
  await assert.rejects(
    () => tools.contactsCreate({ displayName: 'X', emailAddresses: [42], account: 'laia' }),
    /emailAddresses\[0\]/,
  );
});

test('contacts_update forwards only defined fields with updatePersonFields and etag', async () => {
  let captured;
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async createContact() { throw new Error('not used'); },
          async updateContact(request) {
            captured = request;
            return {
              data: {
                resourceName: request.resourceName,
                etag: 'etag-new',
                names: [{ displayName: 'Updated' }],
              },
            };
          },
        },
      },
    },
    personal: { gmail: {}, calendar: {}, people: { people: {} } },
  });

  await tools.contactsUpdate({
    resourceName: 'people/c123',
    etag: 'etag-old',
    displayName: 'Updated',
    account: 'laia',
  });

  assert.equal(captured.resourceName, 'people/c123');
  assert.equal(captured.requestBody.etag, 'etag-old');
  assert.equal(captured.requestBody.names[0].displayName, 'Updated');
  assert.match(captured.updatePersonFields, /\bnames\b/);
  assert.equal(captured.requestBody.emailAddresses, undefined);
  assert.equal(captured.requestBody.phoneNumbers, undefined);
  assert.equal(captured.requestBody.organizations, undefined);

  let captured2;
  const tools2 = createReadTools({
    laia: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async createContact() { throw new Error('not used'); },
          async updateContact(request) {
            captured2 = request;
            return { data: { resourceName: request.resourceName, etag: 'e2' } };
          },
        },
      },
    },
    personal: { gmail: {}, calendar: {}, people: { people: {} } },
  });

  await tools2.contactsUpdate({
    resourceName: 'people/c456',
    etag: 'e0',
    emailAddresses: ['x@example.com'],
    phoneNumbers: ['+15550000000'],
    organization: 'NewCo',
    account: 'laia',
  });

  assert.match(captured2.updatePersonFields, /\bemailAddresses\b/);
  assert.match(captured2.updatePersonFields, /\bphoneNumbers\b/);
  assert.match(captured2.updatePersonFields, /\borganizations\b/);
  assert.equal(captured2.updatePersonFields.includes('names'), false);
});

test('contacts_update rejects missing etag and bad resourceName', async () => {
  const tools = createReadTools({
    laia: {
      gmail: {},
      calendar: {},
      people: {
        people: {
          async createContact() { throw new Error('not used'); },
          async updateContact() { throw new Error('updateContact should not be called'); },
        },
      },
    },
    personal: { gmail: {}, calendar: {}, people: { people: {} } },
  });

  await assert.rejects(
    () => tools.contactsUpdate({ resourceName: 'people/c1', displayName: 'X', account: 'laia' }),
    /etag must be/,
  );
  await assert.rejects(
    () => tools.contactsUpdate({ resourceName: 'bad-prefix', etag: 'e1', displayName: 'X', account: 'laia' }),
    /resourceName must start with "people\/"/,
  );
  await assert.rejects(
    () => tools.contactsUpdate({ resourceName: 'people/c1', etag: 'e1', account: 'laia' }),
    /at least one field/,
  );
});