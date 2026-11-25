import {
  addDays,
  differenceInCalendarDays,
  differenceInMinutes,
  isSameDay,
  max as latest,
  min as earliest,
  parseISO,
  startOfDay,
  startOfWeek,
} from "date-fns";
import type { CalendarEvent } from "./calendar-api";

const DAY_MINUTES = 24 * 60;
const MIN_BLOCK_MINUTES = 30;

export interface Span {
  event: CalendarEvent;
  start: Date;
  end: Date;
}

export interface Bar extends Span {
  col: number;
  span: number;
  lane: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

export interface Block extends Span {
  top: number;
  bottom: number;
  col: number;
  cols: number;
  width: number;
}

export function weekDays(anchor: Date): Date[] {
  const first = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}

export function eventSpan(event: CalendarEvent): Span {
  return { event, start: parseISO(event.start), end: parseISO(event.end) };
}

export function spansDays(span: Span): boolean {
  return span.event.allDay || differenceInMinutes(span.end, span.start) >= DAY_MINUTES;
}

export function laneBars(spans: Span[], days: Date[]): Bar[] {
  const first = days[0]!;
  const last = days.length - 1;
  const lanes: number[] = [];
  return spans
    .map((span) => {
      const startCol = Math.max(0, differenceInCalendarDays(span.start, first));
      const endCol = Math.min(last, differenceInCalendarDays(new Date(span.end.getTime() - 1), first));
      return { span, startCol, endCol };
    })
    .filter(({ startCol, endCol }) => startCol <= last && endCol >= 0 && endCol >= startCol)
    .sort(
      (a, b) => a.startCol - b.startCol || b.endCol - a.endCol || a.span.event.title.localeCompare(b.span.event.title),
    )
    .map(({ span, startCol, endCol }) => {
      let lane = lanes.findIndex((freeFrom) => freeFrom <= startCol);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = endCol + 1;
      return {
        ...span,
        col: startCol,
        span: endCol - startCol + 1,
        lane,
        clippedStart: span.start < first,
        clippedEnd: span.end > addDays(days[last]!, 1),
      };
    });
}

interface Placed extends Span {
  top: number;
  bottom: number;
  reach: number;
  col: number;
}

export function dayBlocks(spans: Span[], day: Date): Block[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const placed: Placed[] = spans
    .filter((span) => span.start < dayEnd && span.end > dayStart && !spansDays(span))
    .map((span) => {
      const top = differenceInMinutes(latest([span.start, dayStart]), dayStart);
      const bottom = Math.max(differenceInMinutes(earliest([span.end, dayEnd]), dayStart), top + 15);
      const reach = Math.min(DAY_MINUTES, Math.max(bottom, top + MIN_BLOCK_MINUTES));
      return { ...span, top, bottom, reach, col: 0 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const blocks: Block[] = [];
  let cluster: Placed[] = [];
  let columns: number[] = [];
  let clusterEnd = -1;
  const flush = (): void => {
    const cols = columns.length;
    for (const item of cluster) {
      let width = 1;
      while (
        item.col + width < cols &&
        !cluster.some((other) => other.col === item.col + width && other.top < item.reach && other.reach > item.top)
      )
        width++;
      const { event, start, end, top, bottom, col } = item;
      blocks.push({ event, start, end, top, bottom, col, cols, width });
    }
    cluster = [];
    columns = [];
  };
  for (const item of placed) {
    if (item.top >= clusterEnd) flush();
    const free = columns.findIndex((freeAt) => freeAt <= item.top);
    item.col = free < 0 ? columns.length : free;
    columns[item.col] = item.reach;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.reach);
  }
  flush();
  return blocks;
}

export const formatter = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(undefined, options);
export const HOUR_ONLY = formatter({ hour: "numeric" });
const HOUR_MINUTE = formatter({ hour: "numeric", minute: "2-digit" });
const LONG_DAY = formatter({ weekday: "long", month: "long", day: "numeric" });
export const LONG_DATE = formatter({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
export const SHORT_MONTH_YEAR = formatter({ month: "short", year: "numeric" });
export const WEEKDAY = formatter({ weekday: "short" });
const DATE_TIME = formatter({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function timeRange(start: Date, end: Date): string {
  return (start.getMinutes() || end.getMinutes() ? HOUR_MINUTE : HOUR_ONLY).formatRange(start, end);
}

export function timeLabel(date: Date): string {
  return (date.getMinutes() ? HOUR_MINUTE : HOUR_ONLY).format(date);
}

export function whenLabel(span: Span): string {
  if (span.event.allDay) {
    const last = addDays(span.end, -1);
    return isSameDay(span.start, last) ? LONG_DAY.format(span.start) : LONG_DAY.formatRange(span.start, last);
  }
  if (isSameDay(span.start, span.end))
    return `${LONG_DAY.format(span.start)} · ${HOUR_MINUTE.formatRange(span.start, span.end)}`;
  return DATE_TIME.formatRange(span.start, span.end);
}
