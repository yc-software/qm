import { api } from "./core-bridge";

export type ResponseStatus = "needsAction" | "accepted" | "declined" | "tentative";
export type Reply = Exclude<ResponseStatus, "needsAction">;

export interface Calendar {
  id: string;
  name: string;
  color: string;
}

interface CalendarAttendee {
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
}

export interface CalendarEvents {
  accountType?: string;
  calendars: Calendar[];
  events: CalendarEvent[];
}

const EVENTS = "/api/calendar/events";

export function listEvents(timeMin: string, timeMax: string): Promise<CalendarEvents> {
  return api<CalendarEvents>(`${EVENTS}?${new URLSearchParams({ timeMin, timeMax })}`);
}

export function respond(calendarId: string, eventId: string, responseStatus: Reply): Promise<CalendarEvent> {
  return api<CalendarEvent>(`${EVENTS}/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify({ responseStatus }),
  });
}
