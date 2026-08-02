import { addDays, isSameDay } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { activeLocale, t } from "./i18n.ts";
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
  if (ms >= 604_800_000 && ms % 604_800_000 === 0) return t("{n}w", { n: ms / 604_800_000 });
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return t("{n}d", { n: ms / 86_400_000 });
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return t("{n}h", { n: ms / 3_600_000 });
  if (ms >= 60_000 && ms % 60_000 === 0) return t("{n}m", { n: ms / 60_000 });
  if (ms >= 60_000) return t("{n}m", { n: (ms / 60_000).toFixed(1).replace(/\.0$/, "") });
  return t("{n}s", { n: Math.round(ms / 1000) });
}

export function cronScheduleSummary(c: CronTimingView): string {
  if (c.schedule.cron) return t("cron {expr}", { expr: c.schedule.cron.trim().replace(/\s+/g, " ") });
  return c.schedule.everyMs != null ? t("every {interval}", { interval: humanizeCronInterval(c.schedule.everyMs) }) : t("one-time");
}

export function cronScheduleDetail(c: CronTimingView): string {
  const summary = cronScheduleSummary(c);
  const label = summary.charAt(0).toUpperCase() + summary.slice(1);
  if (c.schedule.cron) {
    const tz = c.schedule.timezone?.trim();
    return tz ? t("{label} ({tz})", { label, tz }) : t("{label} (default timezone)", { label });
  }
  if (c.schedule.firstFireAt == null) return label;
  if (c.schedule.everyMs != null && c.lastFiredAt != null) return label;
  const when = formatCronDateTime(c.schedule.firstFireAt, Date.now(), c.schedule.timezone);
  return c.schedule.everyMs != null ? t("{label} - first run {when}", { label, when }) : t("{label} - run {when}", { label, when });
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
  if (next != null) {
    const when = formatCronDateTime(next, now, tz);
    return next <= now ? t("due {when}", { when }) : t("next {when}", { when });
  }
  if (c.lastFiredAt != null) return t("last {when}", { when: relTime(c.lastFiredAt) });
  if (c.schedule.firstFireAt != null) return t("first {when}", { when: formatCronDateTime(c.schedule.firstFireAt, now, tz) });
  return t("never fired");
}

export function cronRunSummaryTitle(c: CronTimingView): string {
  const tz = c.schedule.cron ? calendarTimezone(c.schedule) : c.schedule.timezone;
  const next = cronNextFire(c);
  if (next != null) return t("Next run: {when}", { when: formatTitleDateTime(next, tz) });
  if (c.lastFiredAt != null) return t("Last fired: {when}", { when: formatTitleDateTime(c.lastFiredAt, tz) });
  if (c.schedule.firstFireAt != null) return t("First run: {when}", { when: formatTitleDateTime(c.schedule.firstFireAt, tz) });
  return t("Never fired");
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
      if (isSameDay(zonedDate, addDays(zonedToday, 1))) return t("tomorrow {time}", { time });
      const dateOpts: Intl.DateTimeFormatOptions =
        zonedDate.getFullYear() === zonedToday.getFullYear()
          ? { month: "short", day: "numeric", timeZone }
          : { month: "short", day: "numeric", year: "numeric", timeZone };
      return `${date.toLocaleDateString(activeLocale(), dateOpts)} ${time}`;
    }
  }
  const time = formatTime(ms);
  if (isSameDay(date, today)) return time;
  if (isSameDay(date, addDays(today, 1))) return t("tomorrow {time}", { time });
  const dateOpts: Intl.DateTimeFormatOptions =
    date.getFullYear() === today.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return `${date.toLocaleDateString(activeLocale(), dateOpts)} ${time}`;
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
    return new Date(ms).toLocaleTimeString(activeLocale(), {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return new Date(ms).toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit" });
  }
}

function formatTitleDateTime(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(activeLocale(), {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(ms);
  } catch {
    return new Date(ms).toLocaleString(activeLocale());
  }
}
