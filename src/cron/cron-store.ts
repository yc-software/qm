import type { Cron, CronFireLogEntry, CronFireNote, CronSchedule, Destination } from "../types.ts";
import { createMemoryCronRows, type CronRows, type TenantCron } from "./cron-table.ts";
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
  type CreateTriggerInput,
  withFields,
} from "../triggers/trigger-store.ts";
import { assertCronRuntime } from "./runtime.ts";
import { currentTenant } from "../tenants/context.ts";
import { hashId } from "../util/crypto.ts";
import { advanceNextFireAt, isCalendarSchedule, normalizeSchedule, recoverNextFireAt } from "./schedule.ts";

export interface CreateCronInput extends CreateTriggerInput {
  runtime?: Cron["runtime"];
  enabled?: boolean;
  schedule: Cron["schedule"];
  title?: string;
  action?: string;
  message?: string;
  unattendedGrants?: string[];
  loopId?: string;
  sessionRef?: string;
}

export interface CronPatch {
  runtime?: Cron["runtime"];
  title?: string;
  action?: string;
  message?: string;
  schedule?: CronSchedule;
  enabled?: boolean;
  archived?: boolean;
  destination?: Destination;
  unattendedGrants?: string[];
  sessionRef?: string | null;
}

export const DEFAULT_FIRE_RUNNING_STALE_MS = 24 * 60 * 60 * 1000;

export const STRANDED_FIRE_NOTE = "fire never completed — stranded by a restart or crash";

export const FIRE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const FIRE_RETENTION_KEEP_PER_CRON = 100;

export interface CronStore {
  create(input: CreateCronInput): Promise<Cron>;
  get(id: string): Promise<Cron | null>;
  list(): Promise<Cron[]>;
  ownedBy(scopeId: string): Promise<Cron[]>;
  tiedTo(threadRefs: readonly string[]): Promise<Cron[]>;
  scheduled(): Promise<TenantCron[]>;
  update(id: string, patch: CronPatch): Promise<Cron | null>;
  delete(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setDestination(id: string, destination: Destination | undefined): Promise<void>;
  beginFire(id: string, entry: CronFireLogEntry, opts?: { exclusive?: boolean }): Promise<BeginFireResult>;
  sweepStrandedFires(now: number): Promise<number>;
  pruneFires(now: number): Promise<number>;
  recordFire(id: string, entry: CronFireLogEntry): Promise<void>;
  listFires(id: string, opts?: { limit?: number }): Promise<{ runs: CronFireLogEntry[]; total: number }>;
  firesByThreadRefs(threadRefs: readonly string[]): Promise<CronFireRecord[]>;
  latestFireForThread(id: string, threadRef: string): Promise<CronFireLogEntry | undefined>;
  setFireNote(id: string, note: CronFireNote): Promise<"applied" | "superseded" | "missing">;
  markFired(id: string, at: number, scheduledAt?: number): Promise<void>;
  markAttempted(id: string, at: number): Promise<void>;
  defer(id: string, until: number): Promise<void>;
  claimSlot(id: string, scheduledAt: number, at: number): Promise<boolean>;
  unclaimSlot(id: string, scheduledAt: number, at: number, priorLastFiredAt: number | undefined): Promise<void>;
  due(now: number): Promise<Array<TenantCron & { scheduledAt: number }>>;
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

function normalizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}...` : trimmed;
}

function editFields(before: Cron, patch: CronPatch): Partial<Cron> {
  assertCronRuntime({ ...before, ...patch });
  const fields: Partial<Cron> = {};
  if (patch.runtime !== undefined) fields.runtime = patch.runtime;
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
  if (patch.unattendedGrants !== undefined) fields.unattendedGrants = patch.unattendedGrants;
  if (patch.sessionRef !== undefined) fields.sessionRef = patch.sessionRef ?? undefined;
  return fields;
}

function buildCron(input: CreateCronInput, now: number): Cron {
  const title = normalizeTitle(input.title);
  const { schedule, nextFireAt } = normalizeSchedule(input.schedule, now);
  const id = hashId([
    contentPart(currentTenant()),
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
  ]);
  return {
    ...buildTriggerBase(input, id, now),
    enabled: input.enabled !== false,
    schedule,
    ...(nextFireAt !== undefined ? { nextFireAt } : {}),
    ...(title ? { title } : {}),
    ...(input.action !== undefined ? { action: input.action } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.unattendedGrants ? { unattendedGrants: input.unattendedGrants } : {}),
    ...(input.loopId ? { loopId: input.loopId } : {}),
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
  };
}

function claimed(cron: Cron, scheduledAt: number, at: number): Cron | null {
  if (cron.archived || !cron.enabled) return null;
  if (recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !== scheduledAt) return null;
  const advanceFrom = isCalendarSchedule(cron.schedule) ? scheduledAt : at;
  return withFields(cron, {
    lastFiredAt: at,
    nextFireAt: advanceNextFireAt(cron.schedule, advanceFrom),
    deferUntil: undefined,
  });
}

export function createCronStore(
  rows: CronRows = createMemoryCronRows(),
  opts?: { staleRunningMs?: number; fires?: CronFireStore },
): CronStore {
  const staleRunningMs = opts?.staleRunningMs ?? DEFAULT_FIRE_RUNNING_STALE_MS;
  const fires = opts?.fires ?? createMemoryCronFireStore();
  const edit = async (id: string, fields: Partial<Cron>) => rows.update(id, (cron) => withFields(cron, fields));
  return {
    async create(input) {
      assertNoEscalation(input);
      assertCronRuntime(input);
      return rows.insertIfAbsent(buildCron(input, Date.now()));
    },
    get: (id) => rows.get(id),
    list: () => rows.list(),
    ownedBy: (scopeId) => rows.ownedBy(scopeId),
    tiedTo: (threadRefs) => rows.tiedTo(threadRefs),
    scheduled: () => rows.scheduled(),
    async update(id, patch) {
      return rows.update(id, (before) => withFields(before, editFields(before, patch)));
    },
    delete: (id) => rows.delete(id),
    async setEnabled(id, enabled) {
      await edit(id, { enabled, ...(enabled ? { archived: false } : {}) });
    },
    async setDestination(id, destination) {
      await edit(id, { destination });
    },
    async beginFire(id, entry, opts) {
      if ((await rows.get(id)) === null) return { begun: false };
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
    async setFireNote(id, note) {
      let applied = false;
      const updated = await rows.update(id, (cron) => {
        applied = !(cron.lastFireNote && cron.lastFireNote.at > note.at);
        return applied ? { ...cron, lastFireNote: note } : cron;
      });
      if (updated === null) return "missing";
      return applied ? "applied" : "superseded";
    },
    async markFired(id, at, scheduledAt) {
      await rows.update(id, (cron) => {
        const advanceFrom = isCalendarSchedule(cron.schedule) ? (scheduledAt ?? at) : at;
        return withFields(cron, {
          lastFiredAt: at,
          nextFireAt: advanceNextFireAt(cron.schedule, advanceFrom),
          deferUntil: undefined,
        });
      });
    },
    async claimSlot(id, scheduledAt, at) {
      let won = false;
      await rows.update(id, (cron) => {
        const next = claimed(cron, scheduledAt, at);
        won = next !== null;
        return next ?? cron;
      });
      return won;
    },
    async unclaimSlot(id, scheduledAt, at, priorLastFiredAt) {
      await rows.update(id, (cron) =>
        cron.lastFiredAt === at ? withFields(cron, { lastFiredAt: priorLastFiredAt, nextFireAt: scheduledAt }) : cron,
      );
    },
    async markAttempted(id, at) {
      await edit(id, { lastAttemptAt: at });
    },
    async defer(id, until) {
      await edit(id, { deferUntil: until });
    },
    async due(now) {
      const due: Array<TenantCron & { scheduledAt: number }> = [];
      for (const c of await rows.dueCandidates(now)) {
        if (isDeferred(c, now)) continue;
        const scheduledAt = recoverNextFireAt(c.schedule, c.createdAt, c.lastFiredAt, c.nextFireAt);
        if (scheduledAt !== undefined && now >= scheduledAt) due.push({ ...c, nextFireAt: scheduledAt, scheduledAt });
      }
      return due;
    },
  };
}
