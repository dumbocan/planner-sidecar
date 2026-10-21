import { z } from "zod";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const EVENT_ID_REGEX = /^[A-Za-z0-9_\-=+/]{1,512}$/;
const MAX_SUBJECT_CHARS = 256;
const MAX_LOCATION_CHARS = 256;
const MAX_BODY_CHARS = 8000;
const MAX_CATEGORIES = 25;
const MAX_ATTENDEES = 50;
const MAX_CATEGORY_CHARS = 64;
const MAX_REMINDER_MINUTES = 10080;
const MAX_DATE_RANGE_DAYS = 365;

export const TOOL_NAMES = [
  "calendar_list_profiles",
  "calendar_status",
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_get_event",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
];

const profileArgSchema = z
  .object({ profile: z.string().optional() })
  .passthrough();

const eventId = () =>
  z
    .string()
    .regex(
      EVENT_ID_REGEX,
      "event_id must be an opaque Microsoft event identifier",
    );

function dateString(name) {
  return z.string().regex(DATE_REGEX, `${name} must be YYYY-MM-DD`);
}

function timeString(name) {
  return z.string().regex(TIME_REGEX, `${name} must be HH:MM (24-hour)`);
}

function timeZoneString() {
  return z.string().min(1).max(100).optional();
}

const calendarId = () => z.string().min(1).max(512).optional();

const calendarListProfilesSchema = profileArgSchema.strict();
const calendarStatusSchema = profileArgSchema.strict();

const calendarListCalendarsSchema = profileArgSchema.strict();

const calendarListEventsSchema = profileArgSchema
  .extend({
    start_date: dateString("start_date"),
    end_date: dateString("end_date").optional(),
    calendar_id: calendarId(),
  })
  .strict();

const calendarGetEventSchema = profileArgSchema
  .extend({
    event_id: z.string().min(1, "event_id is required").max(512),
    calendar_id: calendarId(),
  })
  .strict();

const calendarCreateEventSchema = profileArgSchema
  .extend({
    subject: z.string().min(1, "subject is required").max(MAX_SUBJECT_CHARS),
    start_date: dateString("start_date"),
    start_time: timeString("start_time"),
    end_date: dateString("end_date"),
    end_time: timeString("end_time"),
    time_zone: timeZoneString(),
    location: z.string().min(1).max(MAX_LOCATION_CHARS).optional(),
    body: z.string().min(1).max(MAX_BODY_CHARS).optional(),
    attendees: z
      .array(z.string().email().max(254))
      .max(MAX_ATTENDEES)
      .optional(),
    is_online_meeting: z.boolean().optional(),
    reminder_minutes_before_start: z
      .number()
      .int()
      .min(0)
      .max(MAX_REMINDER_MINUTES)
      .optional(),
    categories: z
      .array(z.string().min(1).max(MAX_CATEGORY_CHARS))
      .max(MAX_CATEGORIES)
      .optional(),
    calendar_id: calendarId(),
  })
  .strict();

const calendarUpdateEventSchema = profileArgSchema
  .extend({
    event_id: z.string().min(1).max(512),
    confirm: z.literal(true, {
      errorMap: () => ({ message: "confirm must be true to update an event" }),
    }),
    subject: z.string().min(1).max(MAX_SUBJECT_CHARS).optional(),
    start_date: dateString("start_date").optional(),
    start_time: timeString("start_time").optional(),
    end_date: dateString("end_date").optional(),
    end_time: timeString("end_time").optional(),
    time_zone: timeZoneString(),
    location: z.string().min(1).max(MAX_LOCATION_CHARS).optional(),
    body: z.string().min(1).max(MAX_BODY_CHARS).optional(),
    attendees: z
      .array(z.string().email().max(254))
      .max(MAX_ATTENDEES)
      .optional(),
    is_online_meeting: z.boolean().optional(),
    reminder_minutes_before_start: z
      .number()
      .int()
      .min(0)
      .max(MAX_REMINDER_MINUTES)
      .optional(),
    categories: z
      .array(z.string().min(1).max(MAX_CATEGORY_CHARS))
      .max(MAX_CATEGORIES)
      .optional(),
    calendar_id: calendarId(),
  })
  .strict();

const calendarDeleteEventSchema = profileArgSchema
  .extend({
    event_id: z.string().min(1).max(512),
    confirm: z.literal(true, {
      errorMap: () => ({ message: "confirm must be true to delete an event" }),
    }),
    calendar_id: calendarId(),
  })
  .strict();

function boundText(value, maximum) {
  return String(value ?? "").slice(0, maximum);
}

function normalizeDateTimePart(part) {
  if (!part || typeof part !== "object") return undefined;
  const dateTime =
    typeof part.dateTime === "string" ? part.dateTime : undefined;
  const timeZone =
    typeof part.timeZone === "string" ? part.timeZone : undefined;
  if (!dateTime && !timeZone) return undefined;
  return {
    ...(dateTime ? { dateTime: boundText(dateTime, 64) } : {}),
    ...(timeZone ? { timeZone: boundText(timeZone, 100) } : {}),
  };
}

function normalizeOrganizer(organizer) {
  if (!organizer || typeof organizer !== "object") return undefined;
  const name =
    typeof organizer.emailAddress?.name === "string"
      ? organizer.emailAddress.name
      : undefined;
  const result = {};
  if (name) result.name = boundText(name, 256);
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeCalendarRow(row) {
  return {
    id: boundText(row?.id, 512),
    name: boundText(row?.name, 256),
    is_default: Boolean(row?.isDefaultCalendar),
  };
}

function normalizeEventRow(row) {
  return {
    id: boundText(row?.id, 512),
    subject: boundText(row?.subject, MAX_SUBJECT_CHARS),
    start: normalizeDateTimePart(row?.start),
    end: normalizeDateTimePart(row?.end),
    location: row?.location?.displayName
      ? boundText(row.location.displayName, MAX_LOCATION_CHARS)
      : undefined,
    organizer: normalizeOrganizer(row?.organizer),
    isOnlineMeeting: Boolean(row?.isOnlineMeeting),
    onlineMeetingUrl:
      row?.onlineMeetingUrl || row?.onlineMeeting?.joinUrl || undefined,
    reminderMinutesBeforeStart:
      typeof row?.reminderMinutesBeforeStart === "number"
        ? row.reminderMinutesBeforeStart
        : undefined,
    isAllDay: Boolean(row?.isAllDay),
    showAs: row?.showAs ? boundText(row.showAs, 64) : undefined,
    categories: Array.isArray(row?.categories)
      ? row.categories.map((c) => boundText(c, MAX_CATEGORY_CHARS))
      : [],
  };
}

function parseArgs(schema, input) {
  return schema.parse(input ?? {});
}

function buildDateTime(date, time) {
  return {
    dateTime: `${date}T${time}:00`,
    timeZone: "UTC",
  };
}

function validateDateRange(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (end.getTime() < start.getTime()) {
    throw new Error("end_date must be on or after start_date");
  }
  const days = Math.round(
    (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (days > MAX_DATE_RANGE_DAYS) {
    throw new Error(
      `date range too large: ${days} days (max ${MAX_DATE_RANGE_DAYS})`,
    );
  }
  return { start, end };
}

function defaultEndDate(startDate) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + MAX_DATE_RANGE_DAYS);
  return start.toISOString().slice(0, 10);
}

function buildUpdateBody(parsed) {
  const body = {};
  if (parsed.subject !== undefined) body.subject = parsed.subject;
  if (parsed.start_date !== undefined && parsed.start_time !== undefined) {
    body.start = buildDateTime(parsed.start_date, parsed.start_time);
  }
  if (parsed.end_date !== undefined && parsed.end_time !== undefined) {
    body.end = buildDateTime(parsed.end_date, parsed.end_time);
  }
  if (parsed.time_zone !== undefined) {
    if (body.start) body.start.timeZone = parsed.time_zone;
    if (body.end) body.end.timeZone = parsed.time_zone;
  }
  if (parsed.location !== undefined)
    body.location = { displayName: parsed.location };
  if (parsed.body !== undefined)
    body.body = { contentType: "HTML", content: parsed.body };
  if (parsed.attendees !== undefined) {
    body.attendees = parsed.attendees.map((email) => ({
      emailAddress: { address: email },
      type: "required",
    }));
  }
  if (parsed.is_online_meeting !== undefined)
    body.isOnlineMeeting = parsed.is_online_meeting;
  if (parsed.reminder_minutes_before_start !== undefined) {
    body.reminderMinutesBeforeStart = parsed.reminder_minutes_before_start;
  }
  if (parsed.categories !== undefined) body.categories = parsed.categories;
  return body;
}

function validateUpdateBody(parsed, body) {
  const startDateSet = parsed.start_date !== undefined;
  const startTimeSet = parsed.start_time !== undefined;
  const endDateSet = parsed.end_date !== undefined;
  const endTimeSet = parsed.end_time !== undefined;
  if (startDateSet !== startTimeSet) {
    throw new Error("start_date and start_time must be provided together");
  }
  if (endDateSet !== endTimeSet) {
    throw new Error("end_date and end_time must be provided together");
  }
  if (Object.keys(body).length === 0) {
    throw new Error(
      "update has no fields to change; supply at least one of subject, start_date+start_time, end_date+end_time, time_zone, location, body, attendees, is_online_meeting, reminder_minutes_before_start, or categories",
    );
  }
}

export function createCalendarTools({ auth, graph, profileStore }) {
  if (!auth || !graph || !profileStore) {
    throw new TypeError("auth, graph, and profileStore are required");
  }

  return {
    async listProfiles(input) {
      parseArgs(calendarListProfilesSchema, input);
      const profiles = await profileStore.listProfiles();
      return { profiles: [...profiles] };
    },

    async status(input) {
      parseArgs(calendarStatusSchema, input);
      const status =
        typeof auth.getStatus === "function"
          ? await auth.getStatus()
          : { connected: false, expiresAt: null };
      return {
        connected: Boolean(status?.connected),
        ...(status?.expiresAt ? { expiresAt: status.expiresAt } : {}),
      };
    },

    async listCalendars(input) {
      parseArgs(calendarListCalendarsSchema, input);
      const rows = await graph.listCalendars();
      return rows.map(normalizeCalendarRow);
    },

    async listEvents(input) {
      const parsed = parseArgs(calendarListEventsSchema, input);
      const startDate = parsed.start_date;
      const endDate = parsed.end_date ?? defaultEndDate(startDate);
      validateDateRange(startDate, endDate);
      const startISO = `${startDate}T00:00:00.000Z`;
      const endMoment = new Date(`${endDate}T00:00:00.000Z`);
      endMoment.setUTCDate(endMoment.getUTCDate() + 1);
      const endISO = endMoment.toISOString();
      const rows = await graph.listEvents({
        startDateTime: startISO,
        endDateTime: endISO,
        calendarId: parsed.calendar_id,
      });
      return rows.map(normalizeEventRow);
    },

    async getEvent(input) {
      const parsed = parseArgs(calendarGetEventSchema, input);
      const row = await graph.getEvent(parsed.event_id, {
        calendarId: parsed.calendar_id,
      });
      return normalizeEventRow(row);
    },

    async createEvent(input) {
      const parsed = parseArgs(calendarCreateEventSchema, input);
      const body = buildUpdateBody(parsed);
      const row = await graph.createEvent(body, {
        calendarId: parsed.calendar_id,
      });
      return {
        id: boundText(row?.id, 512),
        subject: boundText(row?.subject ?? parsed.subject, MAX_SUBJECT_CHARS),
        start: normalizeDateTimePart(row?.start) ?? body.start,
        end: normalizeDateTimePart(row?.end) ?? body.end,
        ...(row?.location?.displayName
          ? {
              location: boundText(row.location.displayName, MAX_LOCATION_CHARS),
            }
          : parsed.location
            ? { location: parsed.location }
            : {}),
      };
    },

    async updateEvent(input) {
      const parsed = parseArgs(calendarUpdateEventSchema, input);
      const body = buildUpdateBody(parsed);
      validateUpdateBody(parsed, body);
      await graph.updateEvent(parsed.event_id, body, {
        calendarId: parsed.calendar_id,
      });
      return {
        updated: true,
        event_id: parsed.event_id,
        changes: Object.keys(body),
      };
    },

    async deleteEvent(input) {
      const parsed = parseArgs(calendarDeleteEventSchema, input);
      await graph.deleteEvent(parsed.event_id, {
        calendarId: parsed.calendar_id,
      });
      return { deleted: true, event_id: parsed.event_id };
    },
  };
}

export const toolSchemas = {
  calendar_list_profiles: calendarListProfilesSchema,
  calendar_status: calendarStatusSchema,
  calendar_list_calendars: calendarListCalendarsSchema,
  calendar_list_events: calendarListEventsSchema,
  calendar_get_event: calendarGetEventSchema,
  calendar_create_event: calendarCreateEventSchema,
  calendar_update_event: calendarUpdateEventSchema,
  calendar_delete_event: calendarDeleteEventSchema,
};
