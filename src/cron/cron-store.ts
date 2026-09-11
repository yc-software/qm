import { randomUUID } from "node:crypto";
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

const FAILURE_BACKOFF_BASE_MS = 5_000;
const FAILURE_BACKOFF_MAX_MS = 5 * 60_000;
const FAILURE_BACKOFF_MAX_FAILURES = 7;

export type DueCron = Cron & { scheduledAt: number };

export interface CronSlotClaim {
  id: string;
  cron: Cron;
  scheduledAt: number;
  claimedAt: number;
  priorLastFiredAt?: number;
}

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
  claimSlot(id: string, scheduledAt: number, at: number): Promise<CronSlotClaim | null>;
  completeSlot(id: string, claim: CronSlotClaim): Promise<void>;
  releaseSlot(id: string, claim: CronSlotClaim, deferUntil?: number): Promise<void>;
  failSlot(id: string, claim: CronSlotClaim, failedAt: number): Promise<number | undefined>;
  completeDueSlot(id: string, cron: DueCron, at: number): Promise<void>;
  deferDueSlot(id: string, cron: DueCron, until: number): Promise<void>;
  failDueSlot(id: string, cron: DueCron, failedAt: number): Promise<number | undefined>;
  disableDueSlot(id: string, cron: DueCron): Promise<void>;
  due(now: number): Promise<DueCron[]>;
}

export function isDeferred(cron: Pick<Cron, "deferUntil">, now: number): boolean {
  return cron.deferUntil !== undefined && now < cron.deferUntil;
}

function normalizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}...` : trimmed;
}

function mergeFields(cron: Cron, fields: Partial<Cron>): Cron {
  const next = { ...cron };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete (next as Record<string, unknown>)[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

function clearAttemptState(cron: Cron): Cron {
  const { activeClaimId: _activeClaimId, failureBackoff: _failureBackoff, ...rest } = cron;
  return rest;
}

function requireAtomicUpdate(backing: DurableMap<Cron>): NonNullable<DurableMap<Cron>["update"]> {
  if (!backing.update) throw new Error("cron store requires atomic durable-map updates");
  return backing.update;
}

function failureBackoffMs(failures: number): number {
  return Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (failures - 1));
}

function nextFailureCount(cron: Cron, scheduledAt: number): number {
  if (cron.failureBackoff?.scheduledAt !== scheduledAt) return 1;
  const failures = cron.failureBackoff.failures;
  if (!Number.isFinite(failures) || failures < 1) return 1;
  return Math.min(FAILURE_BACKOFF_MAX_FAILURES, Math.floor(failures) + 1);
}

function attemptIdentity(cron: Cron): string {
  return contentPart([
    cron.schedule,
    cron.title,
    cron.action,
    cron.message,
    cron.loopId,
    cron.destination,
    cron.runAs,
    cron.members,
    cron.unattendedGrants,
    cron.recipientConsent,
  ]);
}

function matchesDueSlot(cron: Cron, expected: DueCron, allowDisabledOneShot = false): boolean {
  const enabled =
    cron.enabled ||
    (allowDisabledOneShot && expected.schedule.everyMs === undefined && expected.schedule.cron === undefined);
  return (
    enabled &&
    !cron.archived &&
    attemptIdentity(cron) === attemptIdentity(expected) &&
    recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) === expected.scheduledAt
  );
}

export function createCronStore(
  backing: DurableMap<Cron> = createMemoryMap<Cron>(),
  opts?: { staleRunningMs?: number; fires?: CronFireStore },
): CronStore {
  const staleRunningMs = opts?.staleRunningMs ?? DEFAULT_FIRE_RUNNING_STALE_MS;
  const fires = opts?.fires ?? createMemoryCronFireStore();
  const updateCron = (id: string, fields: Partial<Cron>, resetAttempt = true): Promise<Cron | null> => {
    if (backing.update)
      return backing.update(id, (cron) => mergeFields(resetAttempt ? clearAttemptState(cron) : cron, fields));
    return backing.merge(
      id,
      resetAttempt ? { ...fields, activeClaimId: undefined, failureBackoff: undefined } : fields,
    );
  };
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
      return updateCron(id, fields, Object.keys(fields).length > 0);
    },
    delete: (id) => backing.delete(id),
    async setEnabled(id, enabled) {
      await updateCron(id, { enabled, ...(enabled ? { archived: false } : {}) });
    },
    async setDestination(id, destination) {
      await updateCron(id, { destination });
    },
    async setRecipientConsent(id, recipientConsent) {
      await updateCron(id, { recipientConsent });
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
        activeClaimId: undefined,
        failureBackoff: undefined,
      });
    },
    async claimSlot(id, scheduledAt, at) {
      const claimId = randomUUID();
      let claim: CronSlotClaim | null = null;
      await requireAtomicUpdate(backing)(id, (cron) => {
        claim = null;
        if (cron.archived || !cron.enabled || isDeferred(cron, at)) return cron;
        if (recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !== scheduledAt)
          return cron;
        claim = {
          id: claimId,
          cron,
          scheduledAt,
          claimedAt: at,
          ...(cron.lastFiredAt !== undefined ? { priorLastFiredAt: cron.lastFiredAt } : {}),
        };
        const advanceFrom = isCalendarSchedule(cron.schedule) ? scheduledAt : at;
        const nextFireAt = advanceNextFireAt(cron.schedule, advanceFrom);
        const failureBackoff = cron.failureBackoff?.scheduledAt === scheduledAt ? cron.failureBackoff : undefined;
        return mergeFields(cron, {
          lastFiredAt: at,
          nextFireAt,
          deferUntil: undefined,
          activeClaimId: claimId,
          failureBackoff,
        });
      });
      return claim;
    },
    async completeSlot(id, claim) {
      await requireAtomicUpdate(backing)(id, (cron) => {
        if (cron.activeClaimId !== claim.id) return cron;
        return mergeFields(cron, { activeClaimId: undefined, failureBackoff: undefined });
      });
    },
    async releaseSlot(id, claim, deferUntil) {
      await requireAtomicUpdate(backing)(id, (cron) => {
        if (cron.activeClaimId !== claim.id || cron.lastFiredAt !== claim.claimedAt) return cron;
        return mergeFields(cron, {
          lastFiredAt: claim.priorLastFiredAt,
          nextFireAt: claim.scheduledAt,
          activeClaimId: undefined,
          ...(deferUntil !== undefined ? { deferUntil: Math.max(cron.deferUntil ?? 0, deferUntil) } : {}),
        });
      });
    },
    async failSlot(id, claim, failedAt) {
      let deferUntil: number | undefined;
      await requireAtomicUpdate(backing)(id, (cron) => {
        deferUntil = undefined;
        if (cron.activeClaimId !== claim.id || cron.lastFiredAt !== claim.claimedAt) return cron;
        const failures = nextFailureCount(cron, claim.scheduledAt);
        deferUntil = Math.max(cron.deferUntil ?? 0, failedAt + failureBackoffMs(failures));
        return mergeFields(cron, {
          lastFiredAt: claim.priorLastFiredAt,
          nextFireAt: claim.scheduledAt,
          activeClaimId: undefined,
          failureBackoff: { scheduledAt: claim.scheduledAt, failures },
          deferUntil,
        });
      });
      return deferUntil;
    },
    async completeDueSlot(id, expected, at) {
      await requireAtomicUpdate(backing)(id, (cron) => {
        if (!matchesDueSlot(cron, expected, true)) return cron;
        const advanceFrom = isCalendarSchedule(cron.schedule) ? expected.scheduledAt : at;
        return mergeFields(cron, {
          lastFiredAt: at,
          nextFireAt: advanceNextFireAt(cron.schedule, advanceFrom),
          deferUntil: undefined,
          failureBackoff: undefined,
          ...(cron.schedule.everyMs === undefined && cron.schedule.cron === undefined ? { enabled: false } : {}),
        });
      });
    },
    async deferDueSlot(id, expected, until) {
      await requireAtomicUpdate(backing)(id, (cron) =>
        matchesDueSlot(cron, expected) ? { ...cron, deferUntil: Math.max(cron.deferUntil ?? 0, until) } : cron,
      );
    },
    async failDueSlot(id, expected, failedAt) {
      let deferUntil: number | undefined;
      await requireAtomicUpdate(backing)(id, (cron) => {
        deferUntil = undefined;
        if (!matchesDueSlot(cron, expected)) return cron;
        const failures = nextFailureCount(cron, expected.scheduledAt);
        deferUntil = Math.max(cron.deferUntil ?? 0, failedAt + failureBackoffMs(failures));
        return {
          ...cron,
          failureBackoff: { scheduledAt: expected.scheduledAt, failures },
          deferUntil,
        };
      });
      return deferUntil;
    },
    async disableDueSlot(id, expected) {
      await requireAtomicUpdate(backing)(id, (cron) =>
        matchesDueSlot(cron, expected) ? mergeFields(clearAttemptState(cron), { enabled: false }) : cron,
      );
    },
    async markAttempted(id, at) {
      await backing.merge(id, { lastAttemptAt: at });
    },
    async defer(id, until) {
      if (backing.update) {
        await backing.update(id, (cron) => ({ ...cron, deferUntil: Math.max(cron.deferUntil ?? 0, until) }));
        return;
      }
      const cron = await backing.get(id);
      if (cron) await backing.merge(id, { deferUntil: Math.max(cron.deferUntil ?? 0, until) });
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
