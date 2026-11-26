const DAY_MINUTES = 24 * 60;
const MIN_BLOCK_MINUTES = 30;
const MINUTE = 60_000;

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
}

function isSameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function calendarDaysBetween(later, earlier) {
  return Math.round(
    (Date.UTC(later.getFullYear(), later.getMonth(), later.getDate()) -
      Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())) /
      (DAY_MINUTES * MINUTE),
  );
}

function minutesBetween(later, earlier) {
  return Math.trunc((later.getTime() - earlier.getTime()) / MINUTE);
}

function parseWhen(value) {
  if (value.length === 10) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
}

export function weekDays(anchor) {
  const first = addDays(startOfDay(anchor), -anchor.getDay());
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}

export function eventSpan(event) {
  return { event, start: parseWhen(event.start), end: parseWhen(event.end) };
}

export function spansDays(span) {
  return span.event.allDay || minutesBetween(span.end, span.start) >= DAY_MINUTES;
}

export function laneBars(spans, days) {
  const first = days[0];
  const last = days.length - 1;
  const lanes = [];
  return spans
    .map((span) => ({
      span,
      startCol: Math.max(0, calendarDaysBetween(span.start, first)),
      endCol: Math.min(last, calendarDaysBetween(new Date(span.end.getTime() - 1), first)),
    }))
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
        clippedEnd: span.end > addDays(days[last], 1),
      };
    });
}

export function dayBlocks(spans, day) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const placed = spans
    .filter((span) => span.start < dayEnd && span.end > dayStart && !spansDays(span))
    .map((span) => {
      const top = minutesBetween(span.start > dayStart ? span.start : dayStart, dayStart);
      const bottom = Math.max(minutesBetween(span.end < dayEnd ? span.end : dayEnd, dayStart), top + 15);
      const reach = Math.min(DAY_MINUTES, Math.max(bottom, top + MIN_BLOCK_MINUTES));
      return { ...span, top, bottom, reach, col: 0 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const blocks = [];
  let cluster = [];
  let columns = [];
  let clusterEnd = -1;
  const flush = () => {
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

export const formatter = (options) => new Intl.DateTimeFormat(undefined, options);
export const HOUR_ONLY = formatter({ hour: "numeric" });
const HOUR_MINUTE = formatter({ hour: "numeric", minute: "2-digit" });
const LONG_DAY = formatter({ weekday: "long", month: "long", day: "numeric" });
export const LONG_DATE = formatter({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
export const SHORT_MONTH_YEAR = formatter({ month: "short", year: "numeric" });
export const WEEKDAY = formatter({ weekday: "short" });
const DATE_TIME = formatter({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function timeRange(start, end) {
  return (start.getMinutes() || end.getMinutes() ? HOUR_MINUTE : HOUR_ONLY).formatRange(start, end);
}

export function timeLabel(date) {
  return (date.getMinutes() ? HOUR_MINUTE : HOUR_ONLY).format(date);
}

export function whenLabel(span) {
  if (span.event.allDay) {
    const last = addDays(span.end, -1);
    return isSameDay(span.start, last) ? LONG_DAY.format(span.start) : LONG_DAY.formatRange(span.start, last);
  }
  if (isSameDay(span.start, span.end))
    return `${LONG_DAY.format(span.start)} · ${HOUR_MINUTE.formatRange(span.start, span.end)}`;
  return DATE_TIME.formatRange(span.start, span.end);
}
