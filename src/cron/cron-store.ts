import {
  createAutomationStore,
  type AutomationStore,
  type CreateAutomationInput,
  normalizeAutomationTitle,
  type AutomationPatch,
} from "../triggers/automation-store.ts";
import type { Cron, AutomationRun, CronFireNote, CronSchedule } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import {
  createMemoryAutomationRunStore,
  type BeginFireResult,
  type AutomationRunRecord,
  type AutomationRunStore,
} from "../triggers/run-store.ts";
import { contentPart } from "../triggers/trigger-store.ts";
import { assertCronRuntime } from "./runtime.ts";
import { advanceNextFireAt, isCalendarSchedule, normalizeSchedule, recoverNextFireAt } from "./schedule.ts";

export interface CreateCronInput extends CreateAutomationInput {
  runtime?: Cron["runtime"];
  schedule: Cron["schedule"];
  unattendedGrants?: string[];
  loopId?: string;
  sessionRef?: string;
}

export interface CronPatch extends AutomationPatch {
  runtime?: Cron["runtime"];
  schedule?: CronSchedule;
  unattendedGrants?: string[];
  sessionRef?: string | null;
}

export const DEFAULT_FIRE_RUNNING_STALE_MS = 24 * 60 * 60 * 1000;

export const STRANDED_FIRE_NOTE = "fire never completed — stranded by a restart or crash";

export const FIRE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const FIRE_RETENTION_KEEP_PER_CRON = 100;

export interface CronStore extends AutomationStore<Cron, CreateCronInput, CronPatch> {
  beginFire(id: string, entry: AutomationRun, opts?: { exclusive?: boolean }): Promise<BeginFireResult>;
  sweepStrandedFires(now: number): Promise<number>;
  pruneFires(now: number): Promise<number>;
  recordFire(id: string, entry: AutomationRun): Promise<void>;
  listFires(id: string, opts?: { limit?: number }): Promise<{ runs: AutomationRun[]; total: number }>;
  firesByThreadRefs(threadRefs: readonly string[]): Promise<AutomationRunRecord[]>;
  latestFireForThread(id: string, threadRef: string): Promise<AutomationRun | undefined>;
  backfillFires(): Promise<number>;
  setFireNote(id: string, note: CronFireNote): Promise<"applied" | "superseded" | "missing">;
  markFired(id: string, at: number, scheduledAt?: number): Promise<void>;
  markAttempted(id: string, at: number): Promise<void>;
  defer(id: string, until: number): Promise<void>;
  claimSlot(id: string, scheduledAt: number, at: number): Promise<boolean>;
  unclaimSlot(id: string, scheduledAt: number, at: number, priorLastFiredAt: number | undefined): Promise<void>;
  due(now: number): Promise<Array<Cron & { scheduledAt: number }>>;
}

export function cronIsActive(cron: Pick<Cron, "enabled" | "archived" | "schedule" | "lastFiredAt">): boolean {
  if (!cron.enabled || cron.archived) return false;
  const oneShot = cron.schedule.cron === undefined && cron.schedule.everyMs === undefined;
  return !(oneShot && cron.lastFiredAt !== undefined);
}

export function cronTiedTo(cron: Pick<Cron, "destination" | "sessionRef">, threadRef: string): boolean {
  return cron.destination?.target === threadRef || cron.sessionRef === threadRef;
}

export function isDeferred(cron: Pick<Cron, "deferUntil">, now: number): boolean {
  return cron.deferUntil !== undefined && now < cron.deferUntil;
}

export function createCronStore(
  backing: DurableMap<Cron> = createMemoryMap<Cron>(),
  opts?: { staleRunningMs?: number; fires?: AutomationRunStore },
): CronStore {
  const staleRunningMs = opts?.staleRunningMs ?? DEFAULT_FIRE_RUNNING_STALE_MS;
  const fires = opts?.fires ?? createMemoryAutomationRunStore();
  const management = createAutomationStore<Cron, CreateCronInput, CronPatch>(backing, {
    create(input, now) {
      assertCronRuntime(input);
      const title = normalizeAutomationTitle(input.title);
      const { schedule, nextFireAt } = normalizeSchedule(input.schedule, now);
      const identity = [
        contentPart(input.owner),
        contentPart(input.ownerScopeId),
        contentPart(input.schedule),
        contentPart(input.action),
        contentPart(input.message),
        contentPart(input.destination),
        contentPart(input.unattendedGrants),
        contentPart(title),
        ...(input.loopId !== undefined ? [contentPart(input.loopId)] : []),
        ...(input.runtime ? [contentPart(input.runtime)] : []),
      ];
      return {
        identity,
        fields: {
          schedule,
          ...(nextFireAt !== undefined ? { nextFireAt } : {}),
          ...(input.unattendedGrants ? { unattendedGrants: input.unattendedGrants } : {}),
          ...(input.loopId ? { loopId: input.loopId } : {}),
          ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
          ...(input.runtime ? { runtime: input.runtime } : {}),
        },
      };
    },
    update(before, patch) {
      assertCronRuntime({ ...before, ...patch });
      const fields: Partial<Cron> = {};
      if (patch.runtime !== undefined) fields.runtime = patch.runtime;
      if (patch.schedule !== undefined) {
        const normalized = normalizeSchedule(patch.schedule, Date.now());
        fields.schedule = normalized.schedule;
        fields.nextFireAt = normalized.nextFireAt;
      }
      if (patch.unattendedGrants !== undefined) fields.unattendedGrants = patch.unattendedGrants;
      if (patch.sessionRef !== undefined) fields.sessionRef = patch.sessionRef ?? undefined;
      return fields;
    },
  });
  return {
    ...management,
    async beginFire(id, entry, opts) {
      if ((await backing.get(id)) === null) return { begun: false };
      if (opts?.exclusive) return fires.beginExclusive(id, entry, staleRunningMs);
      await fires.record(id, entry);
      return { begun: true };
    },
    async sweepStrandedFires(now) {
      return fires.sweepStranded(now, staleRunningMs, STRANDED_FIRE_NOTE);
    },
    async pruneFires(now) {
      return fires.pruneEnded({ endedBefore: now - FIRE_RETENTION_MS, keepPerCron: FIRE_RETENTION_KEEP_PER_CRON });
    },
    async recordFire(id, entry) {
      await fires.record(id, entry);
    },
    listFires: (id, opts) => fires.listByCron(id, opts),
    firesByThreadRefs: (threadRefs) => fires.listByThreadRefs(threadRefs),
    latestFireForThread: (id, threadRef) => fires.latestForThread(id, threadRef),
    async backfillFires() {
      let backfilled = 0;
      for (const [id, cron] of await backing.entries()) {
        const log = cron.fireLog;
        if (log === undefined) continue;
        if (log.length) {
          await fires.backfill(id, log);
          backfilled += log.length;
        }
        if (backing.update) {
          await backing.update(id, (current) => {
            const { fireLog: _legacy, ...rest } = current;
            return rest;
          });
        } else {
          await backing.merge(id, { fireLog: undefined });
        }
      }
      return backfilled;
    },
    async setFireNote(id, note) {
      let applied = false;
      const apply = (cron: Cron): Cron => {
        applied = !(cron.lastFireNote && cron.lastFireNote.at > note.at);
        return applied ? { ...cron, lastFireNote: note } : cron;
      };
      if (backing.update) {
        if ((await backing.update(id, apply)) === null) return "missing";
        return applied ? "applied" : "superseded";
      }
      const cron = await backing.get(id);
      if (!cron) return "missing";
      apply(cron);
      if (applied) await backing.merge(id, { lastFireNote: note });
      return applied ? "applied" : "superseded";
    },
    async markFired(id, at, scheduledAt) {
      const cron = await backing.get(id);
      if (!cron) return;
      const advanceFrom = isCalendarSchedule(cron.schedule) ? (scheduledAt ?? at) : at;
      await backing.merge(id, {
        lastFiredAt: at,
        nextFireAt: advanceNextFireAt(cron.schedule, advanceFrom),
        deferUntil: undefined,
      });
    },
    async claimSlot(id, scheduledAt, at) {
      let claimed = false;
      const transform = (cron: Cron): Cron => {
        claimed = false;
        if (cron.archived || !cron.enabled) return cron;
        if (recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !== scheduledAt)
          return cron;
        claimed = true;
        const advanceFrom = isCalendarSchedule(cron.schedule) ? scheduledAt : at;
        const next = advanceNextFireAt(cron.schedule, advanceFrom);
        const { nextFireAt: _dropped, deferUntil: _cleared, ...rest } = cron;
        return { ...rest, lastFiredAt: at, ...(next !== undefined ? { nextFireAt: next } : {}) };
      };
      if (backing.update) {
        await backing.update(id, transform);
        return claimed;
      }
      const cron = await backing.get(id);
      if (!cron) return false;
      const next = transform(cron);
      if (!claimed) return false;
      await backing.merge(id, { lastFiredAt: next.lastFiredAt, nextFireAt: next.nextFireAt, deferUntil: undefined });
      return true;
    },
    async unclaimSlot(id, scheduledAt, at, priorLastFiredAt) {
      const restore = (cron: Cron): Cron => {
        if (cron.lastFiredAt !== at) return cron;
        const { lastFiredAt: _dropped, ...rest } = cron;
        return {
          ...rest,
          ...(priorLastFiredAt !== undefined ? { lastFiredAt: priorLastFiredAt } : {}),
          nextFireAt: scheduledAt,
        };
      };
      if (backing.update) {
        await backing.update(id, restore);
        return;
      }
      const cron = await backing.get(id);
      if (!cron || cron.lastFiredAt !== at) return;
      await backing.merge(id, { lastFiredAt: priorLastFiredAt, nextFireAt: scheduledAt });
    },
    async markAttempted(id, at) {
      await backing.merge(id, { lastAttemptAt: at });
    },
    async defer(id, until) {
      await backing.merge(id, { deferUntil: until });
    },
    async due(now) {
      const due: Array<Cron & { scheduledAt: number }> = [];
      for (const c of await backing.all()) {
        if (c.archived || !c.enabled || isDeferred(c, now)) continue;
        const scheduledAt = recoverNextFireAt(c.schedule, c.createdAt, c.lastFiredAt, c.nextFireAt);
        if (scheduledAt !== undefined && now >= scheduledAt) due.push({ ...c, nextFireAt: scheduledAt, scheduledAt });
      }
      return due;
    },
  };
}

export const DROP_RUN_AS_MIGRATION = {
  id: "durable-map/crons/0001-drop-run-as",
  statements: [
    ...["crons", "loops"].map(
      (table) => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    ),
    `UPDATE crons SET json = jsonb_set(json, '{owner}', to_jsonb('system:' || (json ->> 'ownerScopeId'))) WHERE json ->> 'runAs' = 'scopeFloor' AND json ->> 'loopId' IS NULL AND json ->> 'ownerScopeId' NOT LIKE 'personal:%'`,
    "UPDATE crons SET json = json - 'runAs' - 'ownerResourcesRequireOpen' - 'members' WHERE json ?| array['runAs', 'ownerResourcesRequireOpen', 'members']",
    "UPDATE loops SET json = json - 'runAs' WHERE json ? 'runAs'",
  ],
};
