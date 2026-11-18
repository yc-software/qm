import { addDays, isSameDay } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { relTime } from "./ui.ts";

export interface CronTimingView {
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
}

function humanizeCronInterval(ms: number): string {
  const units: Array<[number, string]> = [
    [604_800_000, "w"],
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
  ];
  for (const [size, label] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${label}`;
  }
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1).replace(/\.0$/, "")}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function cronScheduleSummary(c: Pick<CronTimingView, "schedule">): string {
  if (c.schedule.cron) return `cron ${c.schedule.cron.trim().replace(/\s+/g, " ")}`;
  return c.schedule.everyMs != null ? `every ${humanizeCronInterval(c.schedule.everyMs)}` : "one-time";
}

export function cronScheduleDetail(c: CronTimingView): string {
  const summary = cronScheduleSummary(c);
  const label = summary.charAt(0).toUpperCase() + summary.slice(1);
  if (c.schedule.cron) {
    const tz = c.schedule.timezone?.trim();
    return `${label}${tz ? ` (${tz})` : " (default timezone)"}`;
  }
  if (c.schedule.firstFireAt == null) return label;
  if (c.schedule.everyMs != null && c.lastFiredAt != null) return label;
  const runLabel = c.schedule.everyMs != null ? "first run" : "run";
  return `${label} - ${runLabel} ${formatCronDateTime(c.schedule.firstFireAt, Date.now(), c.schedule.timezone)}`;
}

export function cronNextFire(c: CronTimingView): number | null {
  if (c.archived || !c.enabled) return null;
  if (c.nextFireAt != null && Number.isFinite(c.nextFireAt)) return c.nextFireAt;
  if (c.schedule.cron) return null;
  if (c.lastFiredAt == null) return c.schedule.firstFireAt ?? c.createdAt;
  if (c.schedule.everyMs == null) return null;
  return c.lastFiredAt + c.schedule.everyMs;
}

export function cronRunSummary(c: CronTimingView, now = Date.now()): string {
  const next = cronNextFire(c);
  const tz = c.schedule.cron ? calendarTimezone(c.schedule) : c.schedule.timezone;
  if (next != null) return `${next <= now ? "due" : "next"} ${formatCronDateTime(next, now, tz)}`;
  if (c.lastFiredAt != null) return `last ${relTime(c.lastFiredAt)}`;
  if (c.schedule.firstFireAt != null) return `first ${formatCronDateTime(c.schedule.firstFireAt, now, tz)}`;
  return "never fired";
}

export function cronRunSummaryTitle(c: CronTimingView): string {
  const tz = c.schedule.cron ? calendarTimezone(c.schedule) : c.schedule.timezone;
  const next = cronNextFire(c);
  if (next != null) return `Next run: ${formatTitleDateTime(next, tz)}`;
  if (c.lastFiredAt != null) return `Last fired: ${formatTitleDateTime(c.lastFiredAt, tz)}`;
  if (c.schedule.firstFireAt != null) return `First run: ${formatTitleDateTime(c.schedule.firstFireAt, tz)}`;
  return "Never fired";
}

export function formatCronDateTime(ms: number, now = Date.now(), timeZone?: string): string {
  const date = new Date(ms);
  const today = new Date(now);
  if (timeZone) {
    const zonedDate = zoned(ms, timeZone);
    const zonedToday = zoned(now, timeZone);
    if (zonedDate && zonedToday) {
      const time = formatTime(ms, timeZone);
      if (isSameDay(zonedDate, zonedToday)) return time;
      if (isSameDay(zonedDate, addDays(zonedToday, 1))) return `tomorrow ${time}`;
      const dateOpts: Intl.DateTimeFormatOptions =
        zonedDate.getFullYear() === zonedToday.getFullYear()
          ? { month: "short", day: "numeric", timeZone }
          : { month: "short", day: "numeric", year: "numeric", timeZone };
      return `${date.toLocaleDateString([], dateOpts)} ${time}`;
    }
  }
  const time = formatTime(ms);
  if (isSameDay(date, today)) return time;
  if (isSameDay(date, addDays(today, 1))) return `tomorrow ${time}`;
  const dateOpts: Intl.DateTimeFormatOptions =
    date.getFullYear() === today.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return `${date.toLocaleDateString([], dateOpts)} ${time}`;
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

function formatTime(ms: number, timeZone?: string): string {
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

function formatTitleDateTime(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat([], {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(ms);
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function cronNumber(field: string, max: number): number | null {
  return /^\d{1,2}$/.test(field) && Number(field) <= max ? Number(field) : null;
}

export function schedulePreset(expression: string): SchedulePreset | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const minute = cronNumber(minuteField, 59);
  if (minute === null || dayOfMonth !== "*" || month !== "*") return null;
  if (hourField === "*" && dayOfWeek === "*") return { kind: "hourly", minute };
  const hour = cronNumber(hourField, 23);
  if (hour === null) return null;
  if (dayOfWeek === "*") return { kind: "daily", hour, minute };
  if (dayOfWeek === "1-5" || dayOfWeek.toUpperCase() === "MON-FRI") return { kind: "weekdays", hour, minute };
  const day = cronNumber(dayOfWeek, 7);
  return day === null ? null : { kind: "weekly", day: day % 7, hour, minute };
}

export function presetCron(preset: SchedulePreset): string {
  if (preset.kind === "hourly") return `${preset.minute} * * * *`;
  let dayOfWeek = "*";
  if (preset.kind === "weekdays") dayOfWeek = "1-5";
  if (preset.kind === "weekly") dayOfWeek = String(preset.day);
  return `${preset.minute} ${preset.hour} * * ${dayOfWeek}`;
}

function clockTime(hour: number, minute: number): string {
  return new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function everyPhrase(ms: number): string {
  const units: Array<[number, string]> = [
    [604_800_000, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, unit] of units) {
    if (ms >= size && ms % size === 0) return ms === size ? `Every ${unit}` : `Every ${ms / size} ${unit}s`;
  }
  return `Every ${humanizeCronInterval(ms)}`;
}

export function describeSchedule(schedule: CronTimingView["schedule"]): string {
  if (schedule.cron) {
    const preset = schedulePreset(schedule.cron);
    if (!preset) return `Custom: ${schedule.cron.trim().replace(/\s+/g, " ")}`;
    if (preset.kind === "hourly") return `Every hour at :${String(preset.minute).padStart(2, "0")}`;
    const time = clockTime(preset.hour, preset.minute);
    if (preset.kind === "daily") return `Every day at ${time}`;
    if (preset.kind === "weekdays") return `Weekdays at ${time}`;
    return `Every ${WEEKDAYS[preset.day]} at ${time}`;
  }
  if (schedule.everyMs != null) return everyPhrase(schedule.everyMs);
  return schedule.firstFireAt != null
    ? `Once, ${formatCronDateTime(schedule.firstFireAt, Date.now(), schedule.timezone)}`
    : "Once";
}

export function timezoneLabel(timeZone: string | undefined): string {
  const zone = timeZone?.trim() || calendarTimezone({});
  if (!zone || !isIntlTimezone(zone)) return zone ?? "";
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
    .formatToParts(Date.now())
    .find((p) => p.type === "timeZoneName")?.value;
  return part && !part.startsWith("GMT") ? part : zone;
}

export function browserTimezone(): string | undefined {
  return calendarTimezone({});
}

export function presetNextRuns(preset: SchedulePreset, timeZone: string, count = 3, now = Date.now()): number[] {
  if (!isIntlTimezone(timeZone)) return [];
  const runs: number[] = [];
  const today = new TZDate(now, timeZone);
  if (preset.kind === "hourly") {
    let at = new TZDate(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      today.getHours(),
      preset.minute,
      timeZone,
    );
    while (runs.length < count) {
      if (at.getTime() > now) runs.push(at.getTime());
      at = new TZDate(at.getTime() + 3_600_000, timeZone);
    }
    return runs;
  }
  for (let offset = 0; runs.length < count && offset < 21; offset++) {
    const at = new TZDate(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + offset,
      preset.hour,
      preset.minute,
      timeZone,
    );
    const day = at.getDay();
    if (preset.kind === "weekdays" && (day === 0 || day === 6)) continue;
    if (preset.kind === "weekly" && day !== preset.day) continue;
    if (at.getTime() > now) runs.push(at.getTime());
  }
  return runs;
}
