import type { Cron, CronFireLogEntry, CronSchedule, Destination, Principal, RecipientConsent } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  contentPart,
  createDeduped,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import { advanceNextFireAt, isCalendarSchedule, normalizeSchedule, recoverNextFireAt } from "./schedule.ts";
import { createMemoryCronFireStore, type CronFirePage, type CronFireStore } from "./cron-fire-store.ts";
import {
  createCronScheduleAuthority,
  scheduleLocalOccurrence,
  type CronScheduleAuthority,
  type CronScheduleAuthorityInput,
  type QmScheduleDefinition,
} from "./schedule-authority.ts";
import { sanitizeDestination } from "../delivery/destination.ts";

export interface CreateCronInput extends CreateTriggerInput {
  schedule: Cron["schedule"];
  title?: string;
  action?: string;
  message?: string;
  runAs?: Cron["runAs"];
  members?: Principal[];
  unattendedGrants?: string[];
  scheduleAuthority?: CronScheduleAuthorityInput;
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
  scheduleAuthority?: CronScheduleAuthorityInput;
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
  recordFire(id: string, entry: CronFireLogEntry): Promise<void>;
  getRuns(id: string, limit?: number): Promise<CronFirePage>;
  markFired(id: string, at: number, scheduledAt?: number): Promise<void>;
  markAttempted(id: string, at: number): Promise<void>;
  claimSlot(id: string, scheduledAt: number, at: number): Promise<boolean>;
  unclaimSlot(id: string, scheduledAt: number, at: number, priorLastFiredAt: number | undefined): Promise<void>;
  due(now: number): Promise<Array<Cron & { scheduledAt: number }>>;
}

function normalizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}...` : trimmed;
}

function authorityInput(authority: CronScheduleAuthority): CronScheduleAuthorityInput {
  return {
    contractVersion: 1,
    authorityRef: authority.authorityRef,
    issuerRef: authority.issuerRef,
    keyId: authority.keyId,
    profileRef: authority.profileRef,
    profileSha256: authority.profileSha256,
    scheduleDefinition: authority.scheduleDefinition,
    runRequestTemplateSha256: authority.runRequestTemplateSha256,
    receiptLifetimeMs: authority.receiptLifetimeMs,
  };
}

function alignAuthorityCursor(cron: Cron, definition: QmScheduleDefinition): Cron {
  if (cron.nextFireAt === undefined) return cron;
  const currentDate = scheduleLocalOccurrence(cron.nextFireAt, definition.timeZone).localDate;
  if (currentDate >= definition.activeFrom) return cron;
  let nextFireAt = advanceNextFireAt(cron.schedule, Date.parse(`${definition.activeFrom}T00:00:00.000Z`) - 172_800_000);
  for (let attempts = 0; nextFireAt !== undefined && attempts < 8; attempts += 1) {
    if (scheduleLocalOccurrence(nextFireAt, definition.timeZone).localDate >= definition.activeFrom) {
      return { ...cron, nextFireAt };
    }
    nextFireAt = advanceNextFireAt(cron.schedule, nextFireAt);
  }
  throw new Error("schedule authority could not align its activeFrom cursor");
}

function reconfigureAuthority(
  cron: Cron,
  input: CronScheduleAuthorityInput | undefined,
  configurationChange: boolean,
  stateChange: boolean,
): Cron {
  const prior = cron.scheduleAuthority;
  if (!prior && !input) return cron;
  const effectiveInput = input ?? authorityInput(prior!);
  const aligned = alignAuthorityCursor(cron, effectiveInput.scheduleDefinition);
  const cursorChanged = aligned.nextFireAt !== cron.nextFireAt;
  let generation = prior?.configurationGeneration ?? 0;
  let stateRevision = prior?.stateRevision ?? 0;
  if (!prior || configurationChange) generation += 1;
  if (!prior || stateChange || cursorChanged) stateRevision += 1;
  const created = createCronScheduleAuthority(aligned, effectiveInput, generation, stateRevision);
  const scheduleAuthority =
    prior?.disabledReason && !aligned.enabled ? { ...created, disabledReason: prior.disabledReason } : created;
  return { ...aligned, scheduleAuthority };
}

async function updateBacking(
  backing: DurableMap<Cron>,
  id: string,
  transform: (cron: Cron) => Cron,
): Promise<Cron | null> {
  if (backing.update) return backing.update(id, transform);
  const cron = await backing.get(id);
  if (!cron) return null;
  const next = transform(cron);
  await backing.put(id, next);
  return next;
}

export function createCronStore(
  backing: DurableMap<Cron> = createMemoryMap<Cron>(),
  fires: CronFireStore = createMemoryCronFireStore(),
): CronStore {
  let readyP: Promise<void> | undefined;
  const ready = () =>
    (readyP ??= (async () => {
      try {
        await backing.get("__cron_fire_log_migration__");
        await fires.ready();
      } catch (error) {
        readyP = undefined;
        throw error;
      }
    })());
  const withoutFireLog = async (cron: Cron | null): Promise<Cron | null> => {
    if (!cron) return null;
    const { fireLog, ...rest } = cron;
    if (fireLog?.length) {
      if (fires.drainInline) await fires.drainInline(cron.id);
      else {
        await fires.import(cron.id, fireLog);
        await backing.merge(cron.id, { fireLog: undefined });
      }
    }
    return rest;
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
        ...(input.scheduleAuthority ? [contentPart(input.scheduleAuthority)] : []),
      ]);
      return createDeduped(backing, contentId, (id) => {
        const cron: Cron = {
          ...buildTriggerBase(input, id, now),
          schedule,
          ...(nextFireAt !== undefined ? { nextFireAt } : {}),
          ...(title ? { title } : {}),
          ...(input.action !== undefined ? { action: input.action } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.runAs ? { runAs: input.runAs } : {}),
          ...(input.members ? { members: input.members } : {}),
          ...(input.unattendedGrants ? { unattendedGrants: input.unattendedGrants } : {}),
        };
        return reconfigureAuthority(cron, input.scheduleAuthority, true, true);
      });
    },
    async get(id) {
      await ready();
      if (fires.drainInline) await fires.drainInline(id);
      return withoutFireLog(await backing.get(id));
    },
    async list() {
      await ready();
      if (fires.drainInline) await fires.drainInline();
      return (await Promise.all((await backing.all()).map(withoutFireLog))) as Cron[];
    },
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
      if (patch.destination !== undefined) fields.destination = sanitizeDestination(patch.destination);
      if (patch.archived === true) fields.enabled = false;
      if (patch.members !== undefined) fields.members = patch.members;
      if (patch.runAs !== undefined) fields.runAs = patch.runAs;
      if (patch.unattendedGrants !== undefined) fields.unattendedGrants = patch.unattendedGrants;
      return updateBacking(backing, id, (cron) => {
        if (!cron.scheduleAuthority && patch.scheduleAuthority !== undefined) {
          throw new Error("schedule authority must be configured when the cron is created");
        }
        const next = { ...cron };
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
          else (next as unknown as Record<string, unknown>)[key] = value;
        }
        const reenabled = cron.enabled === false && next.enabled === true;
        const stateChange =
          cron.enabled !== next.enabled || cron.archived !== next.archived || cron.nextFireAt !== next.nextFireAt;
        const configurationChange =
          patch.title !== undefined ||
          patch.action !== undefined ||
          patch.message !== undefined ||
          patch.schedule !== undefined ||
          patch.destination !== undefined ||
          patch.members !== undefined ||
          patch.runAs !== undefined ||
          patch.unattendedGrants !== undefined ||
          patch.scheduleAuthority !== undefined ||
          reenabled;
        return reconfigureAuthority(next, patch.scheduleAuthority, configurationChange, stateChange);
      });
    },
    async delete(id) {
      if (backing.deleteIf) {
        const deleted = await backing.deleteIf(id, (cron) => {
          if (cron.scheduleAuthority) throw new Error("signed schedule crons cannot be deleted");
          return true;
        });
        if (deleted) await fires.delete(id);
        return;
      }
      const cron = await backing.get(id);
      if (cron?.scheduleAuthority) throw new Error("signed schedule crons cannot be deleted");
      await backing.delete(id);
      await fires.delete(id);
    },
    async setEnabled(id, enabled) {
      await updateBacking(backing, id, (cron) => {
        const next = { ...cron, enabled, ...(enabled ? { archived: false } : {}) };
        return reconfigureAuthority(
          next,
          undefined,
          !cron.enabled && enabled,
          cron.enabled !== enabled || cron.archived !== next.archived,
        );
      });
    },
    async setDestination(id, destination) {
      await updateBacking(backing, id, (cron) => {
        const next = { ...cron };
        if (destination === undefined) delete next.destination;
        else next.destination = sanitizeDestination(destination);
        return reconfigureAuthority(next, undefined, true, false);
      });
    },
    async setRecipientConsent(id, recipientConsent) {
      await updateBacking(backing, id, (cron) => {
        const next = { ...cron, recipientConsent };
        return reconfigureAuthority(next, undefined, true, false);
      });
    },
    async recordFire(id, entry) {
      await ready();
      if (fires.drainInline) await fires.drainInline(id);
      if (!(await withoutFireLog(await backing.get(id)))) return;
      await fires.record(id, entry);
    },
    async getRuns(id, limit) {
      await ready();
      await withoutFireLog(await backing.get(id));
      return fires.list(id, limit);
    },
    async markFired(id, at, scheduledAt) {
      await updateBacking(backing, id, (cron) => {
        if (cron.scheduleAuthority) return cron;
        const advanceFrom = isCalendarSchedule(cron.schedule) ? (scheduledAt ?? at) : at;
        const nextFireAt = advanceNextFireAt(cron.schedule, advanceFrom);
        const { nextFireAt: _dropped, ...rest } = cron;
        return { ...rest, lastFiredAt: at, ...(nextFireAt !== undefined ? { nextFireAt } : {}) };
      });
    },
    async claimSlot(id, scheduledAt, at) {
      let claimed = false;
      const transform = (cron: Cron): Cron => {
        claimed = false;
        if (cron.scheduleAuthority || cron.archived || !cron.enabled) return cron;
        if (recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !== scheduledAt)
          return cron;
        claimed = true;
        const advanceFrom = isCalendarSchedule(cron.schedule) ? scheduledAt : at;
        const next = advanceNextFireAt(cron.schedule, advanceFrom);
        const { nextFireAt: _dropped, ...rest } = cron;
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
      await backing.merge(id, { lastFiredAt: next.lastFiredAt, nextFireAt: next.nextFireAt });
      return true;
    },
    async unclaimSlot(id, scheduledAt, at, priorLastFiredAt) {
      const restore = (cron: Cron): Cron => {
        if (cron.scheduleAuthority || cron.lastFiredAt !== at) return cron;
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
      if (!cron || cron.scheduleAuthority || cron.lastFiredAt !== at) return;
      await backing.merge(id, { lastFiredAt: priorLastFiredAt, nextFireAt: scheduledAt });
    },
    async markAttempted(id, at) {
      await backing.merge(id, { lastAttemptAt: at });
    },
    async due(now) {
      const due: Array<Cron & { scheduledAt: number }> = [];
      await ready();
      if (fires.drainInline) await fires.drainInline();
      for (const row of await backing.all()) {
        const c = (await withoutFireLog(row))!;
        if (c.archived || !c.enabled) continue;
        const scheduledAt = recoverNextFireAt(c.schedule, c.createdAt, c.lastFiredAt, c.nextFireAt);
        if (scheduledAt !== undefined && now >= scheduledAt) due.push({ ...c, nextFireAt: scheduledAt, scheduledAt });
      }
      return due;
    },
  };
}
