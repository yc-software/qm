import type { Cron, CronFireLogEntry, CronFireNote, CronSchedule, Destination } from "../types.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import {
  cols,
  retireJsonKeysMigration,
  mapToTableMigration,
  ownerIndexMigration,
  type TableSpec,
  typedTable,
} from "../persistence/typed-table.ts";
import {
  type BeginFireResult,
  createPostgresCronFireStore,
  type CronFireRecord,
  type CronFireStore,
} from "./fire-store.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  contentPart,
  TRIGGER_COLUMNS,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";
import { assertCronRuntime } from "./runtime.ts";
import { hashId } from "../util/crypto.ts";
import { jsonbStringify } from "../util/text.ts";
import { advanceNextFireAt, isCalendarSchedule, normalizeSchedule, recoverNextFireAt } from "./schedule.ts";

export interface CreateCronInput extends CreateTriggerInput {
  runtime?: Cron["runtime"];
  enabled?: boolean;
  schedule: Cron["schedule"];
  title?: string;
  action?: string;
  message?: string;
  unattendedGrants?: string[];
  inbox?: Cron["inbox"];
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
  byOwner(scopeId: string): Promise<Cron[]>;
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
  defer(id: string, until: number): Promise<void>;
  claimSlot(id: string, scheduledAt: number, at: number): Promise<boolean>;
  unclaimSlot(id: string, scheduledAt: number, at: number, priorLastFiredAt: number | undefined): Promise<void>;
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

const CRONS: TableSpec = {
  table: "crons",
  key: "id",
  keyIsField: true,
  columns: {
    ...TRIGGER_COLUMNS,
    ...cols(`runtime jsonb, schedule jsonb!, nextFireAt bigint, deferUntil bigint, title text,
    archived boolean, action text, message text, inbox jsonb, unattendedGrants text[],
    sessionRef text, lastFireNote jsonb`),
  },
};

export const CRONS_MIGRATION = mapToTableMigration("triggers/crons/0001-typed", CRONS, {
  statements: [
    `CREATE INDEX IF NOT EXISTS crons_resource_search_gin ON crons USING gin
     (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(action, '') || ' ' || coalesce(message, '')))`,
  ],
});

const CRONS_MIGRATIONS = [
  retireJsonKeysMigration("triggers/crons/0000-drop-retired-keys", "crons", {
    drop: ["adminAuthorization", "deliveryMigration", "initialVerificationRequestedAt", "groupDeliveryTestRequestedAt"],
  }),
  CRONS_MIGRATION,
  ownerIndexMigration("crons"),
];

export function createCronStore(
  databaseUrl: string,
  opts: { staleRunningMs?: number; fires?: CronFireStore } = {},
): CronStore {
  const staleRunningMs = opts.staleRunningMs ?? DEFAULT_FIRE_RUNNING_STALE_MS;
  const fires = opts.fires ?? createPostgresCronFireStore(databaseUrl);
  const db = createPgPool(databaseUrl, CRONS_MIGRATIONS);
  const { q } = db;
  const table = typedTable<Cron>(db, CRONS);
  const { get } = table;
  const { update } = table;
  return {
    async create(input) {
      assertNoEscalation(input);
      assertCronRuntime(input);
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
        contentPart(input.unattendedGrants),
        contentPart(title),
        ...(input.inbox !== undefined ? [contentPart(input.inbox)] : []),
        ...(input.runtime ? [contentPart(input.runtime)] : []),
      ]);
      return table.insertOrGet(contentId, {
        ...buildTriggerBase(input, contentId, now),
        enabled: input.enabled !== false,
        schedule,
        ...(nextFireAt !== undefined ? { nextFireAt } : {}),
        ...(title ? { title } : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.unattendedGrants ? { unattendedGrants: input.unattendedGrants } : {}),
        ...(input.inbox ? { inbox: input.inbox } : {}),
        ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
        ...(input.runtime ? { runtime: input.runtime } : {}),
      });
    },
    get,
    list: table.all,
    byOwner: (scopeId) => table.where("ownerScopeId", scopeId),
    async update(id, patch) {
      const before = await get(id);
      if (!before) return null;
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
      return update(id, (cron) => ({ ...cron, ...fields }));
    },
    async delete(id) {
      await table.delete(id);
    },
    async setEnabled(id, enabled) {
      await q(`UPDATE crons SET enabled = $2, archived = CASE WHEN $2 THEN false ELSE archived END WHERE id = $1`, [
        id,
        enabled,
      ]);
    },
    async setDestination(id, destination) {
      await q(`UPDATE crons SET destination = $2 WHERE id = $1`, [
        id,
        destination === undefined ? null : jsonbStringify(destination),
      ]);
    },
    async beginFire(id, entry, opts) {
      if ((await get(id)) === null) return { begun: false };
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
      const apply = (cron: Cron): Cron => {
        applied = !(cron.lastFireNote && cron.lastFireNote.at > note.at);
        return applied ? { ...cron, lastFireNote: note } : cron;
      };
      if ((await update(id, apply)) === null) return "missing";
      return applied ? "applied" : "superseded";
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
      await update(id, transform);
      return claimed;
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
      await update(id, restore);
    },
    async defer(id, until) {
      await q(`UPDATE crons SET defer_until = $2 WHERE id = $1`, [id, until]);
    },
  };
}
