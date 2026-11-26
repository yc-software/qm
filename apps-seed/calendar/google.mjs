const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const REPLIES = ["accepted", "declined", "tentative"];

export class CalendarError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function brokerClient({ apiUrl, token, fetchImpl = fetch }) {
  return async function google(method, path, body) {
    const resp = await fetchImpl(new URL("/v1/credentials/broker", apiUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": token },
      body: JSON.stringify({
        connector: "www.googleapis.com",
        method,
        url: `${CALENDAR_API}${path}`,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    });
    const envelope = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (envelope.error === "connector_unavailable" || envelope.error === "connector_not_lent")
        throw new CalendarError(409, "not_connected", "Connect your Google account to see your calendar.");
      throw new CalendarError(502, "calendar_unavailable", envelope.message ?? `broker ${resp.status}`);
    }
    if (envelope.status === 401 || envelope.status === 403)
      throw new CalendarError(409, "calendar_unavailable", "Reconnect Google to use your calendar.", {
        reconnect: true,
      });
    if (envelope.status === 404) throw new CalendarError(404, "calendar_unavailable", "That event no longer exists.");
    if (envelope.status < 200 || envelope.status >= 300)
      throw new CalendarError(502, "calendar_unavailable", `Google Calendar answered ${envelope.status}.`);
    return envelope.body ? JSON.parse(envelope.body) : {};
  };
}

function toCalendar(entry) {
  const id = entry.id ?? "";
  return { id, name: entry.summaryOverride ?? entry.summary ?? id, color: entry.backgroundColor ?? "" };
}

function toEvent(event, cal, colors) {
  const allDay = Boolean(event.start?.date);
  const attendees = (event.attendees ?? [])
    .filter((a) => a.email)
    .map((a) => ({
      email: a.email,
      ...(a.displayName ? { name: a.displayName } : {}),
      responseStatus: a.responseStatus ?? "needsAction",
      self: a.self === true,
      organizer: a.organizer === true,
    }));
  const selfResponse = attendees.find((a) => a.self)?.responseStatus;
  const meetUrl =
    event.hangoutLink ?? event.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  return {
    id: event.id ?? "",
    calendarId: cal.id,
    title: event.summary ?? "",
    start: (allDay ? event.start?.date : event.start?.dateTime) ?? "",
    end: (allDay ? event.end?.date : event.end?.dateTime) ?? "",
    allDay,
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(meetUrl ? { meetUrl } : {}),
    htmlLink: event.htmlLink ?? "",
    color: (event.colorId && colors.event?.[event.colorId]?.background) || cal.color,
    attendees,
    ...(selfResponse ? { selfResponse } : {}),
  };
}

async function allPages(google, path, params) {
  const items = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ ...params, ...(pageToken ? { pageToken } : {}) });
    const page = await google("GET", `${path}?${query}`);
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

export async function listEvents(google, timeMin, timeMax) {
  if (Number.isNaN(Date.parse(timeMin)) || Number.isNaN(Date.parse(timeMax)))
    throw new CalendarError(400, "bad_request", "timeMin and timeMax must be dates.");
  const [entries, colors] = await Promise.all([
    allPages(google, "/users/me/calendarList", { minAccessRole: "reader" }),
    google("GET", "/colors"),
  ]);
  const calendars = entries.filter((entry) => entry.selected).map(toCalendar);
  const perCalendar = await Promise.all(
    calendars.map(async (cal) =>
      (
        await allPages(google, `/calendars/${encodeURIComponent(cal.id)}/events`, {
          timeMin,
          timeMax,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "2500",
        })
      ).map((event) => toEvent(event, cal, colors)),
    ),
  );
  return { calendars, events: perCalendar.flat().sort((a, b) => a.start.localeCompare(b.start)) };
}

export async function respond(google, calendarId, eventId, responseStatus) {
  if (!REPLIES.includes(responseStatus))
    throw new CalendarError(400, "bad_request", "responseStatus must be accepted, declined or tentative.");
  const cal = encodeURIComponent(calendarId);
  const path = `/calendars/${cal}/events/${encodeURIComponent(eventId)}`;
  const [entry, current, colors] = await Promise.all([
    google("GET", `/users/me/calendarList/${cal}`),
    google("GET", path),
    google("GET", "/colors"),
  ]);
  const attendees = (current.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus } : a));
  const updated = await google("PATCH", `${path}?sendUpdates=all`, { attendees });
  return toEvent(updated, toCalendar(entry), colors);
}
