import { Cron as Croner } from "croner";
import type { CronSchedule } from "../types.ts";

export const DEFAULT_CRON_TIMEZONE = "America/Los_Angeles";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RECURRING_CRON_MS = 60_000;

export interface NormalizedSchedule {
  schedule: CronSchedule;
  nextFireAt?: number;
}

export function isCalendarSchedule(schedule: CronSchedule): boolean {
  return schedule.cron !== undefined;
}

function finiteEpochMs(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value))
    throw new Error(`${name} must be a finite integer timestamp in ms`);
  return value;
}

function finitePositiveMs(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer number of ms`);
  return value;
}

function normalizeTimezone(input: string | undefined, fallback: string = DEFAULT_CRON_TIMEZONE): string {
  const tz = (input?.trim() || fallback).trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`invalid IANA timezone: ${tz}`);
  }
  return tz;
}

function normalizeCronExpression(input: string): string {
  const cron = input.trim().replace(/\s+/g, " ");
  if (cron.split(" ").length !== 5) throw new Error("schedule.cron must be a 5-field cron expression");
  return cron;
}

function calendarJob(schedule: CronSchedule): Croner {
  if (!schedule.cron) throw new Error("schedule.cron is required");
  return new Croner(schedule.cron, { timezone: normalizeTimezone(schedule.timezone), paused: true, mode: "5-part" });
}

function nextCalendarFireAfter(schedule: CronSchedule, after: number): number | undefined {
  const next = calendarJob(schedule).nextRun(new Date(after));
  return next ? next.getTime() : undefined;
}

export function normalizeSchedule(
  input: CronSchedule,
  now: number,
  defaultTimezone: string = DEFAULT_CRON_TIMEZONE,
): NormalizedSchedule {
  const hasCron = input.cron !== undefined;
  const hasEveryMs = input.everyMs !== undefined;
  const hasFirstFireAt = input.firstFireAt !== undefined;
  const hasTimezone = input.timezone !== undefined;

  if (hasCron) {
    if (typeof input.cron !== "string" || input.cron.trim() === "")
      throw new Error("schedule.cron must be a non-empty string");
    if (hasEveryMs || hasFirstFireAt) throw new Error("schedule.cron cannot be combined with everyMs or firstFireAt");
    const schedule = {
      cron: normalizeCronExpression(input.cron),
      timezone: normalizeTimezone(input.timezone, defaultTimezone),
    };
    const nextFireAt = nextCalendarFireAfter(schedule, now);
    if (nextFireAt === undefined) throw new Error("schedule.cron has no future fire time");
    return { schedule, nextFireAt };
  }

  if (hasTimezone) throw new Error("schedule.timezone requires schedule.cron");

  if (input.everyMs !== undefined && input.everyMs >= DAY_MS) {
    throw new Error(
      "schedule.everyMs >= 24h is almost always a clock-time schedule in disguise — it anchors to an " +
        "arbitrary epoch, has no timezone, and drifts with DST. Use {cron,timezone} for daily/weekly/monthly " +
        'runs (e.g. { cron: "30 7 * * 1-5", timezone: "America/Los_Angeles" }). Reserve everyMs for ' +
        "genuine sub-day polling where wall-clock time does not matter.",
    );
  }

  const everyMs = finitePositiveMs(input.everyMs, "schedule.everyMs");
  const firstFireAt =
    finiteEpochMs(input.firstFireAt, "schedule.firstFireAt") ?? (everyMs !== undefined ? now + everyMs : now);
  const schedule = { ...(everyMs !== undefined ? { everyMs } : {}), firstFireAt };
  return { schedule, nextFireAt: firstFireAt };
}

export function validateUserSchedule(schedule: CronSchedule): void {
  if (schedule.everyMs !== undefined && schedule.everyMs < MIN_RECURRING_CRON_MS) {
    throw new Error(`schedule.everyMs must be at least ${MIN_RECURRING_CRON_MS}ms`);
  }
}

export function recoverNextFireAt(
  schedule: CronSchedule,
  createdAt: number,
  lastFiredAt: number | undefined,
  nextFireAt: number | undefined,
): number | undefined {
  if (nextFireAt !== undefined) return finiteEpochMs(nextFireAt, "nextFireAt");
  if (isCalendarSchedule(schedule)) return nextCalendarFireAfter(schedule, lastFiredAt ?? createdAt);
  if (lastFiredAt === undefined) return finiteEpochMs(schedule.firstFireAt, "schedule.firstFireAt") ?? createdAt;
  const everyMs = finitePositiveMs(schedule.everyMs, "schedule.everyMs");
  return everyMs === undefined ? undefined : lastFiredAt + everyMs;
}

export function advanceNextFireAt(schedule: CronSchedule, firedAt: number): number | undefined {
  if (isCalendarSchedule(schedule)) return nextCalendarFireAfter(schedule, firedAt);
  const everyMs = finitePositiveMs(schedule.everyMs, "schedule.everyMs");
  return everyMs === undefined ? undefined : firedAt + everyMs;
}
