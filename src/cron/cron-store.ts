import type {
  Cron,
  CronFireLogEntry,
  CronFireNote,
  CronSchedule,
  Destination,
  Principal,
  RecipientConsent,
} from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import {
  createMemoryCronFireStore,
  type BeginFireResult,
  type CronFireRecord,
  type CronFireStore,
} from "./fire-store.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  contentPart,
  createDeduped,
  setTriggerRecipientConsent,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import { advanceNextFireAt, isCalendarSchedule, normalizeSchedule, recoverNextFireAt } from "./schedule.ts";

export interface CreateCronInput extends CreateTriggerInput {
  schedule: Cron["schedule"];
  title?: string;
  action?: string;
  message?: string;
  runAs?: Cron["runAs"];
  members?: Principal[];
  unattendedGrants?: string[];
  loopId?: string;
}

export interface CronPatch {
  title?: string;
  action?: string;
  message?: string;
  schedule?: CronSchedule;
  enabled?: boolean;
  archived?: boolean;
  destination?: Destination;
  members?: Principal[];
  runAs?: Cron["runAs"];
  unattendedGrants?: string[];
}

export const DEFAULT_FIRE_RUNNING_STALE_MS = 24 * 60 * 60 * 1000;

export const STRANDED_FIRE_NOTE = "fire never completed — stranded by a restart or crash";

export const FIRE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const FIRE_RETENTION_KEEP_PER_CRON = 100;

export interface CronStore {
  create(input: CreateCronInput): Promise<Cron>;
  get(id: string): Promise<Cron | null>;
  list(): Promise<Cron[]>;
  update(id: string, patch: CronPatch): Promise<Cron | null>;
  delete(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setDestination(id: string, destination: Destination | undefined): Promise<void>;
  setRecipientConsent(id: string, recipientConsent: RecipientConsent): Promise<void>;
  beginFire(id: string, entry: CronFireLogEntry, opts?: { exclusive?: boolean }): Promise<BeginFireResult>;
  sweepStrandedFires(now: number): Promise<number>;
  pruneFires(now: number): Promise<number>;
  recordFire(id: string, entry: CronFireLogEntry): Promise<void>;
  listFires(id: string, opts?: { limit?: number }): Promise<{ runs: CronFireLogEntry[]; total: number }>;
  firesByThreadRefs(threadRefs: readonly string[]): Promise<CronFireRecord[]>;
  latestFireForThread(id: string, threadRef: string): Promise<CronFireLogEntry | undefined>;
  backfillFires(): Promise<number>;
  setFireNote(id: string, note: CronFireNote): Promise<"applied" | "superseded" | "missing">;
  markFired(id: string, at: number, scheduledAt?: number): Promise<void>;
  markAttempted(id: string, at: number): Promise<void>;
  defer(id: string, until: number): Promise<void>;
  claimSlot(id: string, scheduledAt: number, at: number): Promise<boolean>;
  unclaimSlot(id: string, scheduledAt: number, at: number, priorLastFiredAt: number | undefined): Promise<void>;
  due(now: number): Promise<Array<Cron & { scheduledAt: number }>>;
}

export function isDeferred(cron: Pick<Cron, "deferUntil">, now: number): boolean {
  return cron.deferUntil !== undefined && now < cron.deferUntil;
}

function normalizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}...` : trimmed;
}

export function createCronStore(
  backing: DurableMap<Cron> = createMemoryMap<Cron>(),
  opts?: { staleRunningMs?: number; fires?: CronFireStore },
): CronStore {
  const staleRunningMs = opts?.staleRunningMs ?? DEFAULT_FIRE_RUNNING_STALE_MS;
  const fires = opts?.fires ?? createMemoryCronFireStore();
  return {
    async create(input) {
      assertNoEscalation(input);
      const now = Date.now();
      const title = normalizeTitle(input.title);
      const { schedule, nextFireAt } = normalizeSchedule(input.schedule, now);
      const contentId = hashId([
        contentPart(input.owner),
        contentPart(input.ownerScopeId),
        contentPart(input.schedule),
        contentPart(input.action),
        contentPart(input.message),
        contentPart(input.destination),
        contentPart(input.runAs),
        contentPart(input.members),
        contentPart(input.unattendedGrants),
        contentPart(title),
        ...(input.loopId !== undefined ? [contentPart(input.loopId)] : []),
      ]);
      return createDeduped(backing, contentId, (id) => ({
        ...buildTriggerBase(input, id, now),
        schedule,
        ...(nextFireAt !== undefined ? { nextFireAt } : {}),
        ...(title ? { title } : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.runAs ? { runAs: input.runAs } : {}),
        ...(input.members ? { members: input.members } : {}),
        ...(input.unattendedGrants ? { unattendedGrants: input.unattendedGrants } : {}),
        ...(input.loopId ? { loopId: input.loopId } : {}),
      }));
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    async update(id, patch) {
      const fields: Partial<Cron> = {};
      if (patch.title !== undefined) fields.title = normalizeTitle(patch.title);
      if (patch.action !== undefined) fields.action = patch.action;
      if (patch.message !== undefined) fields.message = patch.message;
      if (patch.schedule !== undefined) {
        const normalized = normalizeSchedule(patch.schedule, Date.now());
        fields.schedule = normalized.schedule;
        fields.nextFireAt = normalized.nextFireAt;
      }
      if (patch.enabled !== undefined) fields.enabled = patch.enabled;
      if (patch.archived !== undefined) fields.archived = patch.archived;
      if (patch.destination !== undefined) fields.destination = patch.destination;
      if (patch.archived === true) fields.enabled = false;
      if (patch.members !== undefined) fields.members = patch.members;
      if (patch.runAs !== undefined) fields.runAs = patch.runAs;
      if (patch.unattendedGrants !== undefined) fields.unattendedGrants = patch.unattendedGrants;
      return backing.merge(id, fields);
    },
    delete: (id) => backing.delete(id),
    async setEnabled(id, enabled) {
      await backing.merge(id, { enabled, ...(enabled ? { archived: false } : {}) });
    },
    async setDestination(id, destination) {
      await backing.merge(id, { destination });
    },
    setRecipientConsent(id, recipientConsent) {
      return setTriggerRecipientConsent(backing, id, recipientConsent);
    },
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
