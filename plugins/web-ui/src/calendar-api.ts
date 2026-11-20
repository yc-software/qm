import { api } from "./core-bridge";

export type ResponseStatus = "needsAction" | "accepted" | "declined" | "tentative";

export type Calendar = { id: string; name: string; color: string; primary: boolean; writable: boolean };

export type CalendarEvent = {
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
};

export type EventInput = {
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  addMeet?: boolean;
};

export type EventPatch = Partial<EventInput> & { responseStatus?: "accepted" | "declined" | "tentative" };

const EVENTS = "/api/calendar/events";

const eventPath = (calendarId: string, eventId: string): string =>
  `${EVENTS}/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`;

export const listEvents = (
  timeMin: string,
  timeMax: string,
): Promise<{ accountType: string; calendars: Calendar[]; events: CalendarEvent[] }> =>
  api(`${EVENTS}?${new URLSearchParams({ timeMin, timeMax })}`);

export const createEvent = (input: EventInput): Promise<CalendarEvent> =>
  api(EVENTS, { method: "POST", body: JSON.stringify(input) });

export const updateEvent = (calendarId: string, eventId: string, patch: EventPatch): Promise<CalendarEvent> =>
  api(eventPath(calendarId, eventId), { method: "PATCH", body: JSON.stringify(patch) });

export const deleteEvent = (calendarId: string, eventId: string): Promise<void> =>
  api(eventPath(calendarId, eventId), { method: "DELETE" });
