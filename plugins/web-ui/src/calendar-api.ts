import { api } from "./core-bridge";

export type ResponseStatus = "needsAction" | "accepted" | "declined" | "tentative";

export interface Calendar {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  writable: boolean;
}

export interface CalendarAttendee {
  email: string;
  name?: string;
  responseStatus: ResponseStatus;
  self: boolean;
  organizer: boolean;
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
  attendees: CalendarAttendee[];
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

export interface CalendarEvents {
  accountType?: string;
  calendars: Calendar[];
  events: CalendarEvent[];
}

const EVENTS = "/api/calendar/events";

const eventPath = (calendarId: string, eventId: string): string =>
  `${EVENTS}/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`;

export function listEvents(timeMin: string, timeMax: string): Promise<CalendarEvents> {
  return api<CalendarEvents>(`${EVENTS}?${new URLSearchParams({ timeMin, timeMax })}`);
}

export function createEvent(input: EventInput): Promise<CalendarEvent> {
  return api<CalendarEvent>(EVENTS, { method: "POST", body: JSON.stringify(input) });
}

export function updateEvent(calendarId: string, eventId: string, patch: EventPatch): Promise<CalendarEvent> {
  return api<CalendarEvent>(eventPath(calendarId, eventId), { method: "PATCH", body: JSON.stringify(patch) });
}

export async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  await api(eventPath(calendarId, eventId), { method: "DELETE" });
}
