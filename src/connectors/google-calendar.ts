import { randomUUID } from "node:crypto";
import { googleApi } from "./google-api.ts";

type ResponseStatus = "needsAction" | "accepted" | "declined" | "tentative";

export interface Calendar {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  writable: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  meetUrl?: string;
  htmlLink: string;
  color: string;
  attendees: { email: string; name?: string; responseStatus: ResponseStatus; self: boolean; organizer: boolean }[];
  selfResponse?: ResponseStatus;
  editable: boolean;
}

export interface EventInput {
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  addMeet?: boolean;
}

export type EventPatch = Partial<EventInput> & { responseStatus?: Exclude<ResponseStatus, "needsAction"> };

interface GoogleCalendarEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  selected?: boolean;
  accessRole?: string;
}

interface GoogleAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: ResponseStatus;
  self?: boolean;
  organizer?: boolean;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  location?: string;
  description?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  htmlLink?: string;
  colorId?: string;
  attendees?: GoogleAttendee[];
  organizer?: { self?: boolean };
  guestsCanModify?: boolean;
}

interface GoogleColors {
  event?: Record<string, { background: string }>;
}

const RESPONSE_STATUSES: readonly string[] = ["needsAction", "accepted", "declined", "tentative"];

export class CalendarInputError extends Error {}

function calendarClient(token: string, fetchImpl: typeof fetch) {
  return googleApi("https://www.googleapis.com/calendar/v3/", token, fetchImpl);
}

type CalendarApi = ReturnType<typeof calendarClient>;

async function allPages<T>(api: CalendarApi, path: string, params: URLSearchParams): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) params.set("pageToken", pageToken);
    const page = await api<{ items?: T[]; nextPageToken?: string }>(`${path}?${params}`);
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

function toCalendar(entry: GoogleCalendarEntry): Calendar {
  return {
    id: entry.id,
    name: entry.summaryOverride ?? entry.summary ?? entry.id,
    color: entry.backgroundColor ?? "",
    primary: entry.primary === true,
    writable: entry.accessRole === "owner" || entry.accessRole === "writer",
  };
}

function toEvent(event: GoogleEvent, calendar: Calendar, colors: GoogleColors): CalendarEvent {
  const allDay = event.start?.date !== undefined;
  const attendees = (event.attendees ?? []).flatMap((a) =>
    a.email
      ? [
          {
            email: a.email,
            ...(a.displayName ? { name: a.displayName } : {}),
            responseStatus: a.responseStatus ?? "needsAction",
            self: a.self === true,
            organizer: a.organizer === true,
          },
        ]
      : [],
  );
  const selfResponse = attendees.find((a) => a.self)?.responseStatus;
  const meetUrl =
    event.hangoutLink ?? event.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  return {
    id: event.id,
    calendarId: calendar.id,
    title: event.summary ?? "",
    start: (allDay ? event.start?.date : event.start?.dateTime) ?? "",
    end: (allDay ? event.end?.date : event.end?.dateTime) ?? "",
    allDay,
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(meetUrl ? { meetUrl } : {}),
    htmlLink: event.htmlLink ?? "",
    color: (event.colorId && colors.event?.[event.colorId]?.background) || calendar.color,
    attendees,
    ...(selfResponse ? { selfResponse } : {}),
    editable: calendar.writable && (event.organizer?.self === true || event.guestsCanModify === true),
  };
}

function isTime(value: unknown, allDay: boolean): value is string {
  return typeof value === "string" && (!allDay || value.length === 10) && !Number.isNaN(Date.parse(value));
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function parseEventPatch(body: unknown, partial: boolean): EventPatch {
  const input = (body ?? {}) as Record<string, unknown>;
  const fail = (): never => {
    throw new CalendarInputError("bad_request");
  };
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail();
  for (const key of ["calendarId", "title", "location", "description"]) if (!optionalString(input[key])) fail();
  if (input.allDay !== undefined && typeof input.allDay !== "boolean") fail();
  if (input.addMeet !== undefined && typeof input.addMeet !== "boolean") fail();
  if (
    input.attendees !== undefined &&
    !(Array.isArray(input.attendees) && input.attendees.every((a) => typeof a === "string" && a.includes("@")))
  )
    fail();
  if (
    input.responseStatus !== undefined &&
    (input.responseStatus === "needsAction" || !RESPONSE_STATUSES.includes(String(input.responseStatus)))
  )
    fail();
  if (input.responseStatus !== undefined && input.attendees !== undefined) fail();
  const timed = input.start !== undefined || input.end !== undefined || input.allDay !== undefined;
  if (timed || !partial) {
    if (typeof input.allDay !== "boolean") fail();
    if (!isTime(input.start, input.allDay as boolean) || !isTime(input.end, input.allDay as boolean)) fail();
  }
  if (!partial && typeof input.title !== "string") fail();
  return input as EventPatch;
}

function toGoogleBody(input: EventPatch, clearOther: boolean): Record<string, unknown> {
  const when = (value: string) =>
    input.allDay
      ? { date: value, ...(clearOther ? { dateTime: null, timeZone: null } : {}) }
      : { dateTime: value, ...(clearOther ? { date: null } : {}) };
  return {
    ...(input.title !== undefined ? { summary: input.title } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.start !== undefined ? { start: when(input.start) } : {}),
    ...(input.end !== undefined ? { end: when(input.end) } : {}),
    ...(input.attendees !== undefined ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
    ...(input.addMeet
      ? {
          conferenceData: {
            createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
          },
        }
      : {}),
  };
}

const eventPath = (calendarId: string, eventId?: string) =>
  `calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;

const WRITE_QUERY = "?sendUpdates=all&conferenceDataVersion=1";

async function withCalendar(api: CalendarApi, calendarId: string, write: Promise<GoogleEvent>): Promise<CalendarEvent> {
  const [entry, event] = await Promise.all([
    api<GoogleCalendarEntry>(`users/me/calendarList/${encodeURIComponent(calendarId)}`),
    write,
  ]);
  const colors = event.colorId ? await api<GoogleColors>("colors") : {};
  return toEvent(event, toCalendar(entry), colors);
}

export async function listCalendarEvents(
  token: string,
  timeMin: string,
  timeMax: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ calendars: Calendar[]; events: CalendarEvent[] }> {
  const api = calendarClient(token, fetchImpl);
  const [entries, colors] = await Promise.all([
    allPages<GoogleCalendarEntry>(api, "users/me/calendarList", new URLSearchParams()),
    api<GoogleColors>("colors"),
  ]);
  const calendars = entries.filter((entry) => entry.selected === true).map(toCalendar);
  const perCalendar = await Promise.all(
    calendars.map(async (calendar) =>
      (
        await allPages<GoogleEvent>(
          api,
          eventPath(calendar.id),
          new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "2500" }),
        )
      ).map((event) => toEvent(event, calendar, colors)),
    ),
  );
  const sortKey = (event: CalendarEvent) => Date.parse(event.start);
  return { calendars, events: perCalendar.flat().sort((a, b) => sortKey(a) - sortKey(b)) };
}

export function createCalendarEvent(
  token: string,
  input: EventInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarEvent> {
  const api = calendarClient(token, fetchImpl);
  const calendarId = input.calendarId ?? "primary";
  return withCalendar(
    api,
    calendarId,
    api<GoogleEvent>(`${eventPath(calendarId)}${WRITE_QUERY}`, { body: toGoogleBody(input, false) }),
  );
}

export async function updateCalendarEvent(
  token: string,
  calendarId: string,
  eventId: string,
  patch: EventPatch,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarEvent> {
  const api = calendarClient(token, fetchImpl);
  const body = toGoogleBody(patch, true);
  if (patch.responseStatus) {
    const current = await api<GoogleEvent>(eventPath(calendarId, eventId));
    body.attendees = (current.attendees ?? []).map((a) =>
      a.self ? { ...a, responseStatus: patch.responseStatus } : a,
    );
  }
  return withCalendar(
    api,
    calendarId,
    api<GoogleEvent>(`${eventPath(calendarId, eventId)}${WRITE_QUERY}`, { method: "PATCH", body }),
  );
}

export async function deleteCalendarEvent(
  token: string,
  calendarId: string,
  eventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await calendarClient(token, fetchImpl)(`${eventPath(calendarId, eventId)}?sendUpdates=all`, { method: "DELETE" });
}
