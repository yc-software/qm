import { auth, calendar, type calendar_v3 } from "@googleapis/calendar";

type ResponseStatus = "needsAction" | "accepted" | "declined" | "tentative";
export type Reply = Exclude<ResponseStatus, "needsAction">;
export const REPLIES: readonly string[] = ["accepted", "declined", "tentative"];

export interface Calendar {
  id: string;
  name: string;
  color: string;
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
}

function client(token: string): calendar_v3.Calendar {
  const oauth = new auth.OAuth2();
  oauth.setCredentials({ access_token: token });
  return calendar({ version: "v3", auth: oauth, fetchImplementation: (url, init) => fetch(url, init) });
}

function toCalendar(entry: calendar_v3.Schema$CalendarListEntry): Calendar {
  const id = entry.id ?? "";
  return { id, name: entry.summaryOverride ?? entry.summary ?? id, color: entry.backgroundColor ?? "" };
}

function toEvent(event: calendar_v3.Schema$Event, cal: Calendar, colors: calendar_v3.Schema$Colors): CalendarEvent {
  const allDay = Boolean(event.start?.date);
  const attendees = (event.attendees ?? []).flatMap((a) =>
    a.email
      ? [
          {
            email: a.email,
            ...(a.displayName ? { name: a.displayName } : {}),
            responseStatus: (a.responseStatus ?? "needsAction") as ResponseStatus,
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

export async function listCalendarEvents(
  token: string,
  timeMin: string,
  timeMax: string,
): Promise<{ calendars: Calendar[]; events: CalendarEvent[] }> {
  const api = client(token);
  const [list, colors] = await Promise.all([
    api.calendarList.list({ minAccessRole: "reader", maxResults: 250 }),
    api.colors.get(),
  ]);
  const calendars = (list.data.items ?? []).filter((entry) => entry.selected).map(toCalendar);
  const perCalendar = await Promise.all(
    calendars.map(async (cal) => {
      const events = await api.events.list({
        calendarId: cal.id,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500,
      });
      return (events.data.items ?? []).map((event) => toEvent(event, cal, colors.data));
    }),
  );
  const events = perCalendar.flat().sort((a, b) => a.start.localeCompare(b.start));
  return { calendars, events };
}

export async function respondToEvent(
  token: string,
  calendarId: string,
  eventId: string,
  responseStatus: Reply,
): Promise<CalendarEvent> {
  const api = client(token);
  const [entry, current, colors] = await Promise.all([
    api.calendarList.get({ calendarId }),
    api.events.get({ calendarId, eventId }),
    api.colors.get(),
  ]);
  const attendees = (current.data.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus } : a));
  const updated = await api.events.patch({ calendarId, eventId, sendUpdates: "all", requestBody: { attendees } });
  return toEvent(updated.data, toCalendar(entry.data), colors.data);
}
