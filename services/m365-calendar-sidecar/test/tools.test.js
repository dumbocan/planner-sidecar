import assert from "node:assert/strict";
import test from "node:test";

import { TOOL_NAMES, createCalendarTools } from "../src/tools.js";

function makeTools(overrides = {}) {
  const profileStore = overrides.profileStore ?? {
    async listProfiles() {
      return ["default"];
    },
  };
  const auth = overrides.auth ?? {
    async getStatus() {
      return { connected: true, expiresAt: "2030-01-01T00:00:00.000Z" };
    },
  };
  const graph = overrides.graph ?? {
    async listCalendars() {
      return [];
    },
    async listEvents() {
      return [];
    },
    async getEvent() {
      return null;
    },
    async createEvent() {
      return { id: "e-1", subject: "Default" };
    },
    async updateEvent() {
      return null;
    },
    async deleteEvent() {
      return null;
    },
  };

  return {
    tools: createCalendarTools({ auth, graph, profileStore }),
    profileStore,
    auth,
    graph,
  };
}

test("TOOL_NAMES exports all eight tool names", () => {
  assert.equal(TOOL_NAMES.length, 8);
  assert.deepEqual(TOOL_NAMES, [
    "calendar_list_profiles",
    "calendar_status",
    "calendar_list_calendars",
    "calendar_list_events",
    "calendar_get_event",
    "calendar_create_event",
    "calendar_update_event",
    "calendar_delete_event",
  ]);
});

test("calendar_list_profiles returns loaded profiles and ignores the profile arg", async () => {
  const calls = [];
  const { tools, profileStore } = makeTools({
    profileStore: {
      async listProfiles() {
        calls.push("listProfiles");
        return ["default", "work"];
      },
    },
  });

  const result = await tools.listProfiles({ profile: "secretaria" });

  assert.deepEqual(result, { profiles: ["default", "work"] });
  assert.deepEqual(calls, ["listProfiles"]);
});

test("calendar_status reports connection state without touching Graph", async () => {
  const graphCalls = [];
  const { tools } = makeTools({
    graph: {
      ...makeTools().graph,
      async listCalendars() {
        graphCalls.push("listCalendars");
        return [];
      },
    },
    auth: {
      async getStatus() {
        return { connected: true, expiresAt: "2030-01-01T00:00:00.000Z" };
      },
    },
  });

  const result = await tools.status({ profile: "secretaria" });

  assert.deepEqual(result, {
    connected: true,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.deepEqual(graphCalls, []);
});

test("calendar_list_calendars returns normalized rows", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async listCalendars() {
        calls.push("listCalendars");
        return [
          {
            id: "c1",
            name: "Personal",
            isDefaultCalendar: true,
            color: "auto",
            canEdit: true,
          },
          {
            id: "c2",
            name: "Trabajo",
            isDefaultCalendar: false,
            hexColor: "#ff0000",
          },
        ];
      },
    },
  });

  const result = await tools.listCalendars({ profile: "secretaria" });

  assert.equal(calls.length, 1);
  assert.deepEqual(result, [
    { id: "c1", name: "Personal", is_default: true },
    { id: "c2", name: "Trabajo", is_default: false },
  ]);
});

test("calendar_list_events forwards start/end ISO and optional calendar_id", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async listEvents(opts) {
        calls.push(opts);
        return [
          {
            id: "e-1",
            subject: "Mtg",
            start: { dateTime: "2026-08-20T10:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-08-20T11:00:00.0000000", timeZone: "UTC" },
          },
        ];
      },
    },
  });

  const result = await tools.listEvents({
    profile: "secretaria",
    start_date: "2026-08-20",
    end_date: "2026-08-20",
    calendar_id: "cal-99",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].startDateTime, "2026-08-20T00:00:00.000Z");
  assert.equal(calls[0].endDateTime, "2026-08-21T00:00:00.000Z");
  assert.equal(calls[0].calendarId, "cal-99");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "e-1");
});

test("calendar_list_events defaults end_date to 366 days ahead when not provided", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async listEvents(opts) {
        calls.push(opts);
        return [];
      },
    },
  });

  await tools.listEvents({ profile: "secretaria", start_date: "2026-08-20" });

  assert.equal(calls[0].startDateTime, "2026-08-20T00:00:00.000Z");
  assert.match(calls[0].endDateTime, /T00:00:00\.000Z$/);
  // ensure end is after start
  assert.ok(
    new Date(calls[0].endDateTime).getTime() >
      new Date(calls[0].startDateTime).getTime(),
  );
});

test("calendar_list_events rejects date range > 366 days", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.listEvents({
      profile: "secretaria",
      start_date: "2026-01-01",
      end_date: "2027-01-02",
    }),
    /366/i,
  );
});

test("calendar_list_events rejects inverted date range", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.listEvents({
      profile: "secretaria",
      start_date: "2026-08-20",
      end_date: "2026-08-19",
    }),
    /before|after|range/i,
  );
});

test("calendar_list_events rejects malformed dates", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.listEvents({
      profile: "secretaria",
      start_date: "2026/08/20",
      end_date: "2026-08-20",
    }),
    /YYYY-MM-DD/i,
  );
});

test("calendar_get_event returns normalized event", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async getEvent(eventId) {
        calls.push(eventId);
        return {
          id: "e-1",
          subject: "Standup",
          start: {
            dateTime: "2026-08-20T10:00:00.0000000",
            timeZone: "Europe/Madrid",
          },
          end: {
            dateTime: "2026-08-20T11:00:00.0000000",
            timeZone: "Europe/Madrid",
          },
          location: { displayName: "Office" },
          isOnlineMeeting: false,
          "@odata.etag": '"e-1"',
        };
      },
    },
  });

  const result = await tools.getEvent({
    profile: "secretaria",
    event_id: "e-1",
  });

  assert.deepEqual(calls, ["e-1"]);
  assert.equal(result.id, "e-1");
  assert.equal(result.subject, "Standup");
  assert.equal(result.location, "Office");
  assert.equal(result.isOnlineMeeting, false);
});

test("calendar_get_event rejects missing event_id", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.getEvent({ profile: "secretaria" }),
    /event_id|required/i,
  );
});

test("calendar_create_event validates required subject and start/end times", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.createEvent({
      profile: "secretaria",
      start_date: "2026-08-20",
      start_time: "10:00",
      end_date: "2026-08-20",
      end_time: "11:00",
    }),
    /subject|required/i,
  );
  await assert.rejects(
    tools.createEvent({
      profile: "secretaria",
      subject: "X",
      start_time: "10:00",
      end_date: "2026-08-20",
      end_time: "11:00",
    }),
    /start_date/i,
  );
});

test("calendar_create_event forwards the Graph API body to graph.createEvent", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async createEvent(body) {
        calls.push(body);
        return {
          id: "e-new",
          subject: "Created",
          start: { dateTime: "2026-08-20T10:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-08-20T11:00:00", timeZone: "UTC" },
        };
      },
    },
  });

  const result = await tools.createEvent({
    profile: "secretaria",
    subject: "Standup",
    start_date: "2026-08-20",
    start_time: "10:00",
    end_date: "2026-08-20",
    end_time: "11:00",
    time_zone: "UTC",
    location: "Office",
    body: "Daily standup notes",
    attendees: ["alice@example.com"],
    is_online_meeting: true,
    reminder_minutes_before_start: 15,
    categories: ["Work"],
  });

  assert.equal(calls.length, 1);
  const body = calls[0];
  assert.equal(body.subject, "Standup");
  assert.equal(body.start.dateTime, "2026-08-20T10:00:00");
  assert.equal(body.start.timeZone, "UTC");
  assert.equal(body.end.dateTime, "2026-08-20T11:00:00");
  assert.equal(body.end.timeZone, "UTC");
  assert.equal(body.location.displayName, "Office");
  assert.equal(body.body.content, "Daily standup notes");
  assert.equal(body.attendees.length, 1);
  assert.equal(body.isOnlineMeeting, true);
  assert.equal(body.reminderMinutesBeforeStart, 15);
  assert.deepEqual(body.categories, ["Work"]);
  assert.equal(result.id, "e-new");
});

test("calendar_update_event requires confirm: true literal", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.updateEvent({
      profile: "secretaria",
      event_id: "e-1",
      subject: "New",
    }),
    /confirm|true/i,
  );
  await assert.rejects(
    tools.updateEvent({
      profile: "secretaria",
      event_id: "e-1",
      confirm: false,
      subject: "New",
    }),
    /confirm|true/i,
  );
});

test("calendar_update_event forwards event_id + filtered body to graph.updateEvent", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async updateEvent(eventId, body) {
        calls.push({ eventId, body });
        return { id: eventId, subject: "New" };
      },
    },
  });

  const result = await tools.updateEvent({
    profile: "secretaria",
    event_id: "e-1",
    confirm: true,
    subject: "New",
    start_date: "2026-08-20",
    start_time: "10:00",
    end_date: "2026-08-20",
    end_time: "11:00",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].eventId, "e-1");
  assert.equal(calls[0].body.subject, "New");
  assert.equal(calls[0].body.start.dateTime, "2026-08-20T10:00:00");
  assert.equal(calls[0].body.end.dateTime, "2026-08-20T11:00:00");
  assert.equal(result.event_id, "e-1");
});

test("calendar_delete_event requires confirm: true literal", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.deleteEvent({ profile: "secretaria", event_id: "e-1" }),
    /confirm|true/i,
  );
  await assert.rejects(
    tools.deleteEvent({
      profile: "secretaria",
      event_id: "e-1",
      confirm: false,
    }),
    /confirm|true/i,
  );
});

test("calendar_delete_event forwards event_id to graph.deleteEvent", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async deleteEvent(eventId) {
        calls.push(eventId);
        return null;
      },
    },
  });

  const result = await tools.deleteEvent({
    profile: "secretaria",
    event_id: "e-1",
    confirm: true,
  });

  assert.deepEqual(calls, ["e-1"]);
  assert.deepEqual(result, { deleted: true, event_id: "e-1" });
});

test("calendar_get_event accepts and forwards calendar_id to graph.getEvent", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async getEvent(eventId, opts) {
        calls.push({ eventId, opts });
        return { id: eventId, subject: "X" };
      },
    },
  });

  const result = await tools.getEvent({
    profile: "secretaria",
    event_id: "e-1",
    calendar_id: "cal-7",
  });

  assert.deepEqual(calls, [{ eventId: "e-1", opts: { calendarId: "cal-7" } }]);
  assert.equal(result.id, "e-1");
});

test("calendar_get_event omits calendar_id when not provided", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async getEvent(eventId, opts) {
        calls.push({ eventId, opts });
        return { id: eventId, subject: "X" };
      },
    },
  });

  await tools.getEvent({ profile: "secretaria", event_id: "e-1" });

  assert.deepEqual(calls, [
    { eventId: "e-1", opts: { calendarId: undefined } },
  ]);
});

test("calendar_update_event forwards calendar_id to graph.updateEvent", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async updateEvent(eventId, body, opts) {
        calls.push({ eventId, body, opts });
        return { id: eventId };
      },
    },
  });

  await tools.updateEvent({
    profile: "secretaria",
    event_id: "e-1",
    confirm: true,
    calendar_id: "cal-7",
    subject: "New",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].eventId, "e-1");
  assert.deepEqual(calls[0].opts, { calendarId: "cal-7" });
  assert.equal(calls[0].body.subject, "New");
});

test("calendar_delete_event accepts calendar_id and forwards it to graph.deleteEvent", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async deleteEvent(eventId, opts) {
        calls.push({ eventId, opts });
        return null;
      },
    },
  });

  const result = await tools.deleteEvent({
    profile: "secretaria",
    event_id: "e-1",
    calendar_id: "cal-7",
    confirm: true,
  });

  assert.deepEqual(calls, [{ eventId: "e-1", opts: { calendarId: "cal-7" } }]);
  assert.deepEqual(result, { deleted: true, event_id: "e-1" });
});

test("calendar_delete_event omits calendar_id from graph.deleteEvent when not provided", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async deleteEvent(eventId, opts) {
        calls.push({ eventId, opts });
        return null;
      },
    },
  });

  await tools.deleteEvent({
    profile: "secretaria",
    event_id: "e-1",
    confirm: true,
  });

  assert.deepEqual(calls, [
    { eventId: "e-1", opts: { calendarId: undefined } },
  ]);
});

test("calendar_update_event rejects start_date without start_time", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.updateEvent({
      profile: "secretaria",
      event_id: "e-1",
      confirm: true,
      start_date: "2026-08-20",
    }),
    /start_date|start_time/i,
  );
});

test("calendar_update_event rejects start_time without start_date", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.updateEvent({
      profile: "secretaria",
      event_id: "e-1",
      confirm: true,
      start_time: "10:00",
    }),
    /start_date|start_time/i,
  );
});

test("calendar_update_event rejects end_date without end_time", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.updateEvent({
      profile: "secretaria",
      event_id: "e-1",
      confirm: true,
      end_date: "2026-08-20",
    }),
    /end_date|end_time/i,
  );
});

test("calendar_update_event rejects end_time without end_date", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.updateEvent({
      profile: "secretaria",
      event_id: "e-1",
      confirm: true,
      end_time: "11:00",
    }),
    /end_date|end_time/i,
  );
});

test("calendar_update_event rejects an empty body when only confirm is provided", async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.updateEvent({
      profile: "secretaria",
      event_id: "e-1",
      confirm: true,
    }),
    /update|at least one|empty|no fields/i,
  );
});

test("calendar_create_event forwards calendar_id to graph.createEvent", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async createEvent(body, opts) {
        calls.push({ body, opts });
        return {
          id: "e-new",
          subject: "Created",
          start: { dateTime: "2026-08-20T10:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-08-20T11:00:00", timeZone: "UTC" },
        };
      },
    },
  });

  await tools.createEvent({
    profile: "secretaria",
    subject: "Standup",
    start_date: "2026-08-20",
    start_time: "10:00",
    end_date: "2026-08-20",
    end_time: "11:00",
    time_zone: "UTC",
    calendar_id: "cal-9",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { calendarId: "cal-9" });
});

test("calendar_create_event omits calendar_id from graph.createEvent when not provided", async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async createEvent(body, opts) {
        calls.push({ body, opts });
        return {
          id: "e-new",
          subject: "Created",
          start: { dateTime: "2026-08-20T10:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-08-20T11:00:00", timeZone: "UTC" },
        };
      },
    },
  });

  await tools.createEvent({
    profile: "secretaria",
    subject: "Standup",
    start_date: "2026-08-20",
    start_time: "10:00",
    end_date: "2026-08-20",
    end_time: "11:00",
    time_zone: "UTC",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { calendarId: undefined });
});

test("calendar_create_event returns no sensitive fields (no organizer emails, no attendee emails)", async () => {
  const { tools } = makeTools({
    graph: {
      async createEvent() {
        return {
          id: "e-new",
          subject: "Standup",
          start: { dateTime: "2026-08-20T10:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-08-20T11:00:00", timeZone: "UTC" },
          organizer: {
            emailAddress: { name: "Owner", address: "owner@example.com" },
          },
          attendees: [
            {
              emailAddress: { name: "Alice", address: "alice@example.com" },
              type: "required",
            },
          ],
        };
      },
    },
  });

  const result = await tools.createEvent({
    profile: "secretaria",
    subject: "Standup",
    start_date: "2026-08-20",
    start_time: "10:00",
    end_date: "2026-08-20",
    end_time: "11:00",
    time_zone: "UTC",
  });

  const json = JSON.stringify(result);
  assert.equal(json.includes("owner@example.com"), false);
  assert.equal(json.includes("alice@example.com"), false);
});

test("calendar_update_event returns no sensitive fields", async () => {
  const { tools } = makeTools({
    graph: {
      async updateEvent(eventId) {
        return {
          id: eventId,
          organizer: {
            emailAddress: { name: "Owner", address: "owner@example.com" },
          },
          attendees: [
            { emailAddress: { name: "Alice", address: "alice@example.com" } },
          ],
        };
      },
    },
  });

  const result = await tools.updateEvent({
    profile: "secretaria",
    event_id: "e-1",
    confirm: true,
    subject: "New",
  });

  const json = JSON.stringify(result);
  assert.equal(json.includes("owner@example.com"), false);
  assert.equal(json.includes("alice@example.com"), false);
});

test("createCalendarTools rejects missing dependencies", () => {
  assert.throws(() => createCalendarTools({}), /required/);
  assert.throws(() => createCalendarTools({ auth: {}, graph: {} }), /required/);
});
