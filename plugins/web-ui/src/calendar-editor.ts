import type { Calendar, CalendarEvent } from "./calendar-api";

export function openEventEditor(opts: {
  initial?: CalendarEvent;
  draft?: { start: string; end: string; allDay: boolean };
  calendars: Calendar[];
  onSaved: (e: CalendarEvent) => void;
  onDeleted?: (e: CalendarEvent) => void;
}): void {
  window.dispatchEvent(new CustomEvent("qm:calendar-editor", { detail: opts }));
}
