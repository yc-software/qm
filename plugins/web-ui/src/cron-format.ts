import { addDays, isSameDay } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { type Locale } from "../../chassis/src/locale.ts";
import { webMessage } from "./messages.ts";
import { relTime } from "./ui.ts";

export interface CronTimingView {
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
}

function humanizeCronInterval(ms: number, selected: Locale): string {
  const units: Array<[number, string]> = [
    [604_800_000, "w"],
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
  ];
  for (const [size, label] of units) {
    if (ms >= size && ms % size === 0) return intervalUnit(ms / size, label, selected);
  }
  if (ms >= 60_000) return intervalUnit(ms / 60_000, "m", selected, 1);
  return intervalUnit(Math.round(ms / 1000), "s", selected);
}

function intervalUnit(value: number, unit: string, selected: Locale, digits = 0): string {
  const number = new Intl.NumberFormat(selected, { maximumFractionDigits: digits }).format(value);
  return webMessage(
    selected,
    `cron.unit.${unit}` as "cron.unit.w" | "cron.unit.d" | "cron.unit.h" | "cron.unit.m" | "cron.unit.s",
    { count: number },
  );
}

export function cronScheduleSummary(c: CronTimingView, selected: Locale = "en"): string {
  if (c.schedule.cron)
    return webMessage(selected, "cron.cron", { expression: c.schedule.cron.trim().replace(/\s+/g, " ") });
  return c.schedule.everyMs != null
    ? webMessage(selected, "cron.every", { duration: humanizeCronInterval(c.schedule.everyMs, selected) })
    : webMessage(selected, "cron.oneTime");
}

export function cronScheduleDetail(c: CronTimingView, selected: Locale = "en"): string {
  const summary = cronScheduleSummary(c, selected);
  const label = summary.charAt(0).toUpperCase() + summary.slice(1);
  if (c.schedule.cron) {
    const tz = c.schedule.timezone?.trim();
    return `${label}${tz ? ` (${tz})` : ` (${webMessage(selected, "cron.defaultTimezone")})`}`;
  }
  if (c.schedule.firstFireAt == null) return label;
  if (c.schedule.everyMs != null && c.lastFiredAt != null) return label;
  const time = formatCronDateTime(c.schedule.firstFireAt, Date.now(), c.schedule.timezone, selected);
  return `${label} - ${webMessage(selected, c.schedule.everyMs != null ? "cron.firstRun" : "cron.run", { time })}`;
}

export function cronNextFire(c: CronTimingView): number | null {
  if (c.archived || !c.enabled) return null;
  if (c.nextFireAt != null && Number.isFinite(c.nextFireAt)) return c.nextFireAt;
  if (c.schedule.cron) return null;
  if (c.lastFiredAt == null) return c.schedule.firstFireAt ?? c.createdAt;
  if (c.schedule.everyMs == null) return null;
  return c.lastFiredAt + c.schedule.everyMs;
}

export function cronRunSummary(c: CronTimingView, now = Date.now(), selected: Locale = "en"): string {
  const next = cronNextFire(c);
  const tz = c.schedule.cron ? calendarTimezone(c.schedule) : c.schedule.timezone;
  if (next != null)
    return webMessage(selected, next <= now ? "cron.due" : "cron.next", {
      time: formatCronDateTime(next, now, tz, selected),
    });
  if (c.lastFiredAt != null) return webMessage(selected, "cron.last", { time: relTime(c.lastFiredAt, now, selected) });
  if (c.schedule.firstFireAt != null)
    return webMessage(selected, "cron.first", { time: formatCronDateTime(c.schedule.firstFireAt, now, tz, selected) });
  return webMessage(selected, "cron.neverFired");
}

export function cronRunSummaryTitle(c: CronTimingView, selected: Locale = "en"): string {
  const tz = c.schedule.cron ? calendarTimezone(c.schedule) : c.schedule.timezone;
  const next = cronNextFire(c);
  if (next != null) return webMessage(selected, "cron.nextRunTitle", { time: formatTitleDateTime(next, tz, selected) });
  if (c.lastFiredAt != null)
    return webMessage(selected, "cron.lastFiredTitle", { time: formatTitleDateTime(c.lastFiredAt, tz, selected) });
  if (c.schedule.firstFireAt != null)
    return webMessage(selected, "cron.firstRunTitle", {
      time: formatTitleDateTime(c.schedule.firstFireAt, tz, selected),
    });
  return webMessage(selected, "cron.neverFiredTitle");
}

export function formatCronDateTime(ms: number, now = Date.now(), timeZone?: string, selected: Locale = "en"): string {
  const date = new Date(ms);
  const today = new Date(now);
  if (timeZone) {
    const zonedDate = zoned(ms, timeZone);
    const zonedToday = zoned(now, timeZone);
    if (zonedDate && zonedToday) {
      const time = formatTime(ms, timeZone, selected);
      if (isSameDay(zonedDate, zonedToday)) return time;
      if (isSameDay(zonedDate, addDays(zonedToday, 1))) return webMessage(selected, "cron.tomorrow", { time });
      const dateOpts: Intl.DateTimeFormatOptions =
        zonedDate.getFullYear() === zonedToday.getFullYear()
          ? { month: "short", day: "numeric", timeZone }
          : { month: "short", day: "numeric", year: "numeric", timeZone };
      return `${new Intl.DateTimeFormat(selected, dateOpts).format(ms)} ${time}`;
    }
  }
  const time = formatTime(ms, undefined, selected);
  if (isSameDay(date, today)) return time;
  if (isSameDay(date, addDays(today, 1))) return webMessage(selected, "cron.tomorrow", { time });
  const dateOpts: Intl.DateTimeFormatOptions =
    date.getFullYear() === today.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return `${new Intl.DateTimeFormat(selected, dateOpts).format(ms)} ${time}`;
}

function calendarTimezone(schedule: { timezone?: string }): string | undefined {
  const configured = schedule.timezone?.trim();
  if (configured) return configured;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const TIMEZONE_VALIDITY = new Map<string, boolean>();

function isIntlTimezone(timeZone: string): boolean {
  let valid = TIMEZONE_VALIDITY.get(timeZone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      valid = true;
    } catch {
      valid = false;
    }
    TIMEZONE_VALIDITY.set(timeZone, valid);
  }
  return valid;
}

function zoned(ms: number, timeZone: string): TZDate | null {
  if (!isIntlTimezone(timeZone)) return null;
  try {
    const date = new TZDate(ms, timeZone);
    return Number.isNaN(date.getFullYear()) ? null : date;
  } catch {
    return null;
  }
}

function formatTime(ms: number, timeZone: string | undefined, selected: Locale): string {
  try {
    return new Intl.DateTimeFormat(selected, {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(selected, { hour: "numeric", minute: "2-digit" }).format(ms);
  }
}

function formatTitleDateTime(ms: number, timeZone: string | undefined, selected: Locale): string {
  try {
    return new Intl.DateTimeFormat(selected, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(selected, { dateStyle: "medium", timeStyle: "short" }).format(ms);
  }
}
