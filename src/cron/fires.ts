import { randomUUID } from "node:crypto";
import type { CronStore } from "./cron-store.ts";
import type { Cron, CronFireLogEntry } from "../triggers/types.ts";
import type { CronJobQueue } from "./job-queue.ts";
import { hashId } from "../util/crypto.ts";
import { boundTenant } from "../tenants/context.ts";

export function cronFireThreadRef(cronId: string, fireKey: string): string {
  return `cron:${cronId}:fire:${hashId([fireKey], 12)}`;
}

export type CronRunRequest =
  | { started: true; fireKey: string }
  | { started: false; reason: "unavailable" }
  | { started: false; reason: "already_running"; running: CronFireLogEntry };

export function describeRunNowRefusal(
  id: string,
  result: CronRunRequest,
  now = Date.now(),
): { error: "already_running" | "bad_request"; message: string } | null {
  if (result.started) return null;
  if (result.reason === "already_running") {
    const ageMin = Math.round((now - result.running.firedAt) / 60_000);
    return {
      error: "already_running",
      message: `cron ${id} is already firing (fire ${result.running.fireKey}, started ${ageMin}m ago) — wait for it to finish instead of firing again`,
    };
  }
  return { error: "bad_request", message: `cron ${id} can't be fired on demand right now` };
}

export interface CronChangeNotifier {
  notifyChanged(cronId: string): void;
}

export interface CronRunRequests {
  runNow(cronId: string): Promise<CronRunRequest>;
}

export function createCronRunRequests(deps: {
  crons: Pick<CronStore, "get" | "beginFire" | "recordFire">;
  queue: Pick<CronJobQueue, "enqueueFire">;
  now?: () => number;
}): CronRunRequests {
  const now = deps.now ?? Date.now;
  return {
    async runNow(cronId) {
      const cron = await deps.crons.get(cronId);
      if (!cron || cron.archived || !cron.enabled) return { started: false, reason: "unavailable" };
      const firedAt = now();
      const fireKey = `cron:${cron.id}:manual:${randomUUID()}`;
      const threadRef = cronFireThreadRef(cron.id, fireKey);
      const begin = await deps.crons.beginFire(
        cronId,
        { fireKey, threadRef, firedAt, status: "running" },
        { exclusive: true },
      );
      if (!begin.begun)
        return begin.running
          ? { started: false, reason: "already_running", running: begin.running }
          : { started: false, reason: "unavailable" };
      try {
        const tenantId = boundTenant();
        await deps.queue.enqueueFire({ cronId, scheduledAt: firedAt, fireKey, ...(tenantId ? { tenantId } : {}) });
      } catch (error) {
        await deps.crons.recordFire(cronId, { fireKey, threadRef, firedAt, endedAt: now(), status: "failed" });
        throw error;
      }
      return { started: true, fireKey };
    },
  };
}

export function echoesCronContextMarkers(s: string): boolean {
  return CRON_CONTEXT_MARKERS.some((marker) => s.includes(marker));
}

export function cronFireReadsNotes(cron: Pick<Cron, "schedule" | "action" | "loopId">): boolean {
  const task = cron.action ?? "";
  if (cron.loopId || !task.trim() || /^!(run|scratch)\s/.test(task.trimStart())) return false;
  return !isOneShotSchedule(cron.schedule);
}

export function flattenFireNote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const CRON_CONTEXT_MARKERS = ["[Cron runtime context]", "[End cron runtime context]"] as const;

export function isOneShotSchedule(schedule: Cron["schedule"]): boolean {
  return schedule.everyMs == null && schedule.cron == null;
}
