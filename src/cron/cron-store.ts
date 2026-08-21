import type { Cron, CronFireLogEntry, CronSchedule, Destination, Principal, RecipientConsent } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
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
import { createMemoryCronFireStore, type CronFirePage, type CronFireStore } from "./cron-fire-store.ts";

export interface CreateCronInput extends CreateTriggerInput {
  schedule: Cron["schedule"];
  title?: string;
  action?: string;
  message?: string;
  runAs?: Cron["runAs"];
  members?: Principal[];
  unattendedGrants?: string[];
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
      }));
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
      if (patch.destination !== undefined) fields.destination = patch.destination;
      if (patch.archived === true) fields.enabled = false;
      if (patch.members !== undefined) fields.members = patch.members;
      if (patch.runAs !== undefined) fields.runAs = patch.runAs;
      if (patch.unattendedGrants !== undefined) fields.unattendedGrants = patch.unattendedGrants;
      return backing.merge(id, fields);
    },
    async delete(id) {
      await Promise.all([backing.delete(id), fires.delete(id)]);
    },
    async setEnabled(id, enabled) {
      await backing.merge(id, { enabled, ...(enabled ? { archived: false } : {}) });
    },
    async setDestination(id, destination) {
      await backing.merge(id, { destination });
    },
    setRecipientConsent(id, recipientConsent) {
      return setTriggerRecipientConsent(backing, id, recipientConsent);
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
      const cron = await backing.get(id);
      if (!cron) return;
      const advanceFrom = isCalendarSchedule(cron.schedule) ? (scheduledAt ?? at) : at;
      await backing.merge(id, { lastFiredAt: at, nextFireAt: advanceNextFireAt(cron.schedule, advanceFrom) });
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
