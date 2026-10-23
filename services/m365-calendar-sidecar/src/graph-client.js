const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

export class GraphError extends Error {
  constructor(message, { status, url, method }) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.url = url;
    this.method = method;
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? GRAPH_BASE_URL).replace(/\/$/, "");
}

function toQueryString(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${String(value)}`);
  }
  const query = parts.join("&");
  return query ? `?${query}` : "";
}

function buildUrl(baseUrl, path, { select, top = 200, query } = {}) {
  const normalizedPath = String(path ?? "").startsWith("/")
    ? String(path)
    : `/${String(path ?? "")}`;
  const params = { ...(query ?? {}) };
  if (select)
    params["$select"] = Array.isArray(select) ? select.join(",") : select;
  if (top !== undefined && top !== null) params["$top"] = top;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}${toQueryString(params)}`;
}

function shouldRetry(status) {
  return status >= 500 && status < 600;
}

export function createGraphClient({
  getAccessToken,
  fetchImpl = globalThis.fetch,
  baseUrl = GRAPH_BASE_URL,
} = {}) {
  if (typeof getAccessToken !== "function") {
    throw new TypeError("getAccessToken must be a function");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  async function request(
    method,
    path,
    { body, select, top, query, headers: extraHeaders } = {},
  ) {
    let accessToken = await getAccessToken({ forceRefresh: false });
    let refreshed = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const url = buildUrl(baseUrl, path, { select, top, query });
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.ok) {
        if (response.status === 204) return null;
        return await response.json();
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        accessToken = await getAccessToken({ forceRefresh: true });
        continue;
      }

      if (shouldRetry(response.status) && attempt < 2) {
        continue;
      }
      let errorText = "";
      if (response.status === 400) {
        try {
          const body = await response.text();
          errorText = ` (body: ${body.substring(0, 200)})`;
        } catch {
          errorText = "";
        }
      }
      console.error(
        JSON.stringify({
          event: "graph_request_failed",
          method,
          url,
          status: response.status,
          text: errorText,
        }),
      );
      throw new GraphError(`Graph request failed with ${response.status}`, {
        status: response.status,
        url,
        method,
      });
    }
  }

  // Graph rejects annotation-only `$select` projections such as
  // `id,@odata.etag`; fetch the resource normally and discard its body.
  async function fetchEventEtag(path) {
    const event = await request("GET", path);
    return event?.["@odata.etag"] ?? null;
  }

  return {
    getJson: (path, options) => request("GET", path, options),
    postJson: (path, body, options = {}) =>
      request("POST", path, { ...options, body }),
    patchJson: (path, body, options = {}) =>
      request("PATCH", path, { ...options, body }),
    deleteJson: (path, options = {}) => request("DELETE", path, options),
    buildUrl: (path, options) => buildUrl(baseUrl, path, options),
    async getMe() {
      return await request("GET", "/me", { select: "id" });
    },
    async listCalendars() {
      const response = await request("GET", "/me/calendars", {
        select: "id,name,isDefaultCalendar",
      });
      return Array.isArray(response?.value) ? response.value : [];
    },
    async listEvents({ startDateTime, endDateTime, calendarId } = {}) {
      const path = calendarId
        ? `/me/calendars/${calendarId}/calendarView`
        : "/me/calendarView";
      const query = {
        startDateTime,
        endDateTime,
        ...(calendarId ? {} : {}),
      };
      const response = await request("GET", path, {
        select:
          "id,subject,start,end,location,organizer,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,reminderMinutesBeforeStart,isAllDay,showAs,categories",
        top: 200,
        query,
      });
      return Array.isArray(response?.value) ? response.value : [];
    },
    async getEvent(eventId, { calendarId } = {}) {
      const path = calendarId
        ? `/me/calendars/${calendarId}/events/${eventId}`
        : `/me/events/${eventId}`;
      return await request("GET", path, {
        select:
          "id,subject,start,end,location,organizer,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,reminderMinutesBeforeStart,isAllDay,showAs,categories",
      });
    },
    async getEventWithEtag(eventId, { calendarId } = {}) {
      const path = calendarId
        ? `/me/calendars/${calendarId}/events/${eventId}`
        : `/me/events/${eventId}`;
      const etag = await fetchEventEtag(path);
      return { id: eventId, etag };
    },
    async createEvent(body, { calendarId } = {}) {
      const path = calendarId
        ? `/me/calendars/${calendarId}/events`
        : "/me/events";
      return await request("POST", path, { body });
    },
    async updateEvent(eventId, body, { calendarId } = {}) {
      const current = await this.getEventWithEtag(eventId, { calendarId });
      const etag = current?.etag;
      const path = calendarId
        ? `/me/calendars/${calendarId}/events/${eventId}`
        : `/me/events/${eventId}`;
      if (!etag)
        throw new GraphError("Event not found or missing etag", {
          status: 404,
          url: path,
          method: "PATCH",
        });

      return await request("PATCH", path, {
        body,
        headers: { "If-Match": etag },
      });
    },
    async deleteEvent(eventId, { calendarId } = {}) {
      const current = await this.getEventWithEtag(eventId, { calendarId });
      const etag = current?.etag;
      const path = calendarId
        ? `/me/calendars/${calendarId}/events/${eventId}`
        : `/me/events/${eventId}`;
      if (!etag)
        throw new GraphError("Event not found or missing etag", {
          status: 404,
          url: path,
          method: "DELETE",
        });

      return await request("DELETE", path, {
        headers: { "If-Match": etag },
      });
    },
  };
}
