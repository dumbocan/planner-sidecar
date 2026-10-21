import assert from "node:assert/strict";
import test from "node:test";

import { GraphError, createGraphClient } from "../src/graph-client.js";

function makeResponse(status, body = "", headers = {}) {
  const headerStore = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headerStore.get(String(name).toLowerCase()) ?? null;
      },
    },
    async json() {
      return body ? JSON.parse(body) : {};
    },
    async text() {
      return body;
    },
  };
}

test("GET /me/calendars appends $select and $top", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(200, JSON.stringify({ value: [] }));
    },
  });

  await client.listCalendars();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/me\/calendars/);
  assert.match(calls[0].url, /\$select=id,name,isDefaultCalendar/);
  assert.match(calls[0].url, /\$top=200/);
  assert.equal(calls[0].init.headers.authorization, "Bearer token-a");
});

test("listEvents uses /me/calendarView with startDateTime and endDateTime query params", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(200, JSON.stringify({ value: [] }));
    },
  });

  await client.listEvents({
    startDateTime: "2026-08-13T00:00:00.000Z",
    endDateTime: "2026-08-20T00:00:00.000Z",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/me\/calendarView/);
  assert.match(calls[0].url, /startDateTime=2026-08-13T00:00:00\.000Z/);
  assert.match(calls[0].url, /endDateTime=2026-08-20T00:00:00\.000Z/);
});

test("listEvents with calendarId uses /me/calendars/{id}/calendarView", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(200, JSON.stringify({ value: [] }));
    },
  });

  await client.listEvents({
    startDateTime: "2026-08-13T00:00:00.000Z",
    endDateTime: "2026-08-20T00:00:00.000Z",
    calendarId: "cal-abc",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/me\/calendars\/cal-abc\/calendarView/);
});

test("401 refreshes token once and retries the request", async () => {
  const calls = [];
  const tokenCalls = [];
  const client = createGraphClient({
    getAccessToken: async (options = {}) => {
      tokenCalls.push(options);
      return options.forceRefresh ? "token-b" : "token-a";
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? makeResponse(401, "denied")
        : makeResponse(200, JSON.stringify({ id: "ok" }));
    },
  });

  const result = await client.getJson("/me");

  assert.deepEqual(result, { id: "ok" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.authorization, "Bearer token-a");
  assert.equal(calls[1].init.headers.authorization, "Bearer token-b");
  assert.deepEqual(tokenCalls, [
    { forceRefresh: false },
    { forceRefresh: true },
  ]);
});

test("5xx responses retry twice before succeeding", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length < 3) return makeResponse(502, "bad gateway");
      return makeResponse(200, JSON.stringify({ value: ["ok"] }));
    },
  });

  const result = await client.getJson("/me/calendars");

  assert.deepEqual(result, { value: ["ok"] });
  assert.equal(calls.length, 3);
});

test("updateEvent sends PATCH with If-Match etag", async () => {
  const calls = [];
  let getCount = 0;
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        method: init.method,
        body: init.body,
        headers: init.headers,
      });
      if (!getCount) {
        getCount += 1;
        return makeResponse(
          200,
          JSON.stringify({
            id: "e-1",
            "@odata.etag": '"etag-1"',
            subject: "Old",
          }),
        );
      }
      return makeResponse(200, JSON.stringify({ id: "e-1", subject: "New" }));
    },
  });

  await client.updateEvent("e-1", { subject: "New" });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "PATCH");
  assert.match(calls[1].url, /\/me\/events\/e-1/);
  assert.equal(calls[1].headers["If-Match"], '"etag-1"');
  assert.equal(JSON.parse(calls[1].body).subject, "New");
});

test("updateEvent throws GraphError when event has no etag", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () =>
      makeResponse(200, JSON.stringify({ id: "e-1", subject: "NoEtag" })),
  });

  await assert.rejects(
    client.updateEvent("e-1", { subject: "New" }),
    (error) => error instanceof GraphError && error.status === 404,
  );
});

test("deleteEvent sends DELETE with If-Match etag", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers });
      if (calls.length === 1) {
        return makeResponse(
          200,
          JSON.stringify({ id: "e-1", "@odata.etag": '"etag-2"' }),
        );
      }
      return makeResponse(204);
    },
  });

  const result = await client.deleteEvent("e-1");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "DELETE");
  assert.match(calls[1].url, /\/me\/events\/e-1/);
  assert.equal(calls[1].headers["If-Match"], '"etag-2"');
  assert.equal(result, null);
});

test("deleteEvent throws GraphError when event has no etag", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => makeResponse(200, JSON.stringify({ id: "e-1" })),
  });

  await assert.rejects(
    client.deleteEvent("e-1"),
    (error) => error instanceof GraphError && error.status === 404,
  );
});

test("createEvent POSTs to /me/events with the body", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      return makeResponse(
        201,
        JSON.stringify({ id: "e-new", subject: "Created" }),
      );
    },
  });

  const result = await client.createEvent({
    subject: "Created",
    start: { dateTime: "2026-08-20T10:00:00", timeZone: "UTC" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/me\/events/);
  assert.equal(JSON.parse(calls[0].body).subject, "Created");
  assert.deepEqual(result, { id: "e-new", subject: "Created" });
});

test("getEvent returns the full event response", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      return makeResponse(
        200,
        JSON.stringify({
          id: "e-1",
          subject: "Get me",
          "@odata.etag": '"etag-x"',
        }),
      );
    },
  });

  const result = await client.getEvent("e-1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/me\/events\/e-1/);
  assert.deepEqual(result, {
    id: "e-1",
    subject: "Get me",
    "@odata.etag": '"etag-x"',
  });
});

test("4xx GraphError keeps body text out of the message", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => makeResponse(400, "secret body must not leak"),
  });

  await assert.rejects(client.getJson("/me"), (error) => {
    assert.ok(error instanceof GraphError);
    assert.equal(error.status, 400);
    assert.equal(error.message.includes("secret body must not leak"), false);
    return true;
  });
});

test("getEvent without calendarId uses /me/events/{eventId}", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(
        200,
        JSON.stringify({ id: "e-1", "@odata.etag": '"e-1"' }),
      );
    },
  });

  await client.getEvent("e-1");

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/me\/events\/e-1/);
  assert.equal(calls[0].url.includes("/calendars/"), false);
});

test("getEvent with calendarId uses /me/calendars/{calendarId}/events/{eventId}", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(
        200,
        JSON.stringify({ id: "e-1", "@odata.etag": '"e-1"' }),
      );
    },
  });

  await client.getEvent("e-1", { calendarId: "cal-7" });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/me\/calendars\/cal-7\/events\/e-1/);
});

test("getEventWithEtag with calendarId uses /me/calendars/{calendarId}/events/{eventId}", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(
        200,
        JSON.stringify({ id: "e-1", "@odata.etag": '"etag-x"' }),
      );
    },
  });

  await client.getEventWithEtag("e-1", { calendarId: "cal-7" });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/me\/calendars\/cal-7\/events\/e-1/);
});

// RED: live Graph returns HTTP 400 for `$select=id,@odata.etag` on
// /me/events/{eventId} (see Microsoft Graph behaviour for single-resource GETs:
// annotation-only $select projections are rejected). The client must fetch the
// etag via the canonical `Prefer: return=minimal` header and read it from the
// ETag response header instead. The etag lookup must never expose sensitive
// event fields (subject, body, attendees, location) in tool responses.

test("getEventWithEtag avoids the broken @odata.etag $select projection", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(
        200,
        JSON.stringify({ id: "e-1", "@odata.etag": 'W/"etag-minimal"' }),
      );
    },
  });

  const result = await client.getEventWithEtag("e-1");

  assert.equal(calls.length, 1);
  // Must not include the broken projection: Graph 400s on
  // $select=id,@odata.etag for /me/events/{id}.
  assert.equal(
    calls[0].url.includes("%40odata.etag"),
    false,
    "url must not encode @odata.etag",
  );
  assert.equal(calls[0].url.includes("$select=id,@odata.etag"), false);
  // The full response body is discarded; only its ETag is retained.
  // ETag is read from the response body but never returned with other fields.
  // Weak prefix and surrounding quotes are stripped so the consumer can wrap
  // the value verbatim in `If-Match: "<value>"`.
  assert.equal(result?.etag, 'W/"etag-minimal"');
});

test("getEventWithEtag does not echo the event body (no subject/body/attendees leakage)", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () =>
      makeResponse(
        200,
        JSON.stringify({
          id: "e-1",
          "@odata.etag": 'W/"etag-x"',
          subject: "Sensitive meeting",
          body: { content: "internal notes" },
          attendees: [{ emailAddress: { address: "alice@example.com" } }],
          location: { displayName: "Boardroom" },
        }),
      ),
  });

  const result = await client.getEventWithEtag("e-1");

  assert.equal(result?.subject, undefined);
  assert.equal(result?.body, undefined);
  assert.equal(result?.attendees, undefined);
  assert.equal(result?.location, undefined);
  // Stripped to the opaque value; the consumer wraps it in `If-Match: "..."`.
  assert.equal(result?.etag, 'W/"etag-x"');
});

test("getEventWithEtag strips the W/ weak prefix and quotes when Graph returns a weak etag", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () =>
      makeResponse(
        200,
        JSON.stringify({ id: "e-1", "@odata.etag": 'W/"weak-etag"' }),
      ),
  });

  const result = await client.getEventWithEtag("e-1");

  // updateEvent/deleteEvent forward the etag verbatim into the If-Match header.
  // Weak etags must NOT be sent in If-Match (RFC 7232): Graph would reject with
  // 412. Strip the W/ prefix and the surrounding quotes to get the opaque value.
  assert.equal(result?.etag, 'W/"weak-etag"');
});

test("getEventWithEtag keeps the strong etag value but strips surrounding quotes", async () => {
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () =>
      makeResponse(
        200,
        JSON.stringify({ id: "e-1", "@odata.etag": '"strong-etag"' }),
      ),
  });

  const result = await client.getEventWithEtag("e-1");

  assert.equal(result?.etag, '"strong-etag"');
});

test("getEventWithEtag returns null etag when Graph omits the header; updateEvent then throws GraphError(404)", async () => {
  let getCallCount = 0;
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async () => {
      getCallCount += 1;
      // 200 OK with NO ETag header (e.g. Graph resource vanished between
      // operations). The body still carries the id but the etag is gone.
      return makeResponse(200, JSON.stringify({ id: "e-1" }));
    },
  });

  const probe = await client.getEventWithEtag("e-1");
  assert.equal(probe?.id, "e-1");
  assert.equal(probe?.etag, null);
  assert.equal(getCallCount, 1);

  await assert.rejects(
    client.updateEvent("e-1", { subject: "New" }),
    (error) => error instanceof GraphError && error.status === 404,
  );

  await assert.rejects(
    client.deleteEvent("e-1"),
    (error) => error instanceof GraphError && error.status === 404,
  );
});

test("updateEvent with calendarId uses /me/calendars/{calendarId}/events/{eventId} for etag lookup AND patch", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers });
      if (init.method === "PATCH")
        return makeResponse(200, JSON.stringify({ id: "e-1" }));
      return makeResponse(
        200,
        JSON.stringify({ id: "e-1", "@odata.etag": '"etag-1"' }),
      );
    },
  });

  await client.updateEvent("e-1", { subject: "New" }, { calendarId: "cal-7" });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/me\/calendars\/cal-7\/events\/e-1/);
  assert.match(calls[1].url, /\/me\/calendars\/cal-7\/events\/e-1/);
  assert.equal(calls[1].headers["If-Match"], '"etag-1"');
});

test("updateEvent without calendarId keeps /me/events/{eventId} (default)", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === "PATCH")
        return makeResponse(200, JSON.stringify({ id: "e-1" }));
      return makeResponse(
        200,
        JSON.stringify({ id: "e-1", "@odata.etag": '"etag-1"' }),
      );
    },
  });

  await client.updateEvent("e-1", { subject: "New" });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/me\/events\/e-1/);
  assert.equal(calls[0].url.includes("/calendars/"), false);
  assert.match(calls[1].url, /\/me\/events\/e-1/);
});

test("deleteEvent with calendarId uses /me/calendars/{calendarId}/events/{eventId}", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === "DELETE") return makeResponse(204);
      return makeResponse(
        200,
        JSON.stringify({ id: "e-1", "@odata.etag": '"etag-2"' }),
      );
    },
  });

  await client.deleteEvent("e-1", { calendarId: "cal-7" });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/me\/calendars\/cal-7\/events\/e-1/);
  assert.match(calls[1].url, /\/me\/calendars\/cal-7\/events\/e-1/);
});

test("createEvent with calendarId uses /me/calendars/{calendarId}/events", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      return makeResponse(201, JSON.stringify({ id: "e-new" }));
    },
  });

  await client.createEvent({ subject: "Created" }, { calendarId: "cal-7" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/me\/calendars\/cal-7\/events/);
});

test("createEvent without calendarId keeps /me/events (default)", async () => {
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async () => "token-a",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      return makeResponse(201, JSON.stringify({ id: "e-new" }));
    },
  });

  await client.createEvent({ subject: "Created" });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/me\/events/);
  assert.equal(calls[0].url.includes("/calendars/"), false);
});
