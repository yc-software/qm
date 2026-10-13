import { createHash } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { CronStore } from "../cron/cron-store.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import { DEFAULT_CRON_TIMEZONE } from "../cron/schedule.ts";
import { reportFailure } from "../util/errors.ts";
import { parseScopeId, type Cron, type CronSchedule, type Principal, type ScopeId } from "../types.ts";
import type { MemoryService } from "./memory-service.ts";

export const MEMORY_TIDY_TASK = `Tidy this conversation's memory notebook. Read it with the memory tool, then make one careful pass:
- Merge duplicates and near-duplicates: edit the oldest of them into the single best wording and delete the rest. Only merge facts that carry the same "(said in …)" tag, or none.
- Delete facts that are stale, superseded by a newer fact, or one-off trivia. When a newer fact corrects an older one, keep one fact that states the current truth.
- Never reword a directive or anything quoted in someone's own words, and keep every "(said in …)" tag exactly as written. Delete one only when it exactly duplicates another or a newer fact explicitly replaces it.
- Move growing operational lists (queues, status logs, ID lists, per-item progress) without a "(said in …)" tag into a durable Files upload, then replace those facts with one fact naming the file's Files id and what it holds. First check sandbox list: if there is no default computer, skip this step; never create a computer or change the default. If the upload doesn't return an id, leave those facts as they are.
- Add no new information and leave every other notebook alone.
Batch your edits and deletes into list calls; each call changes everything or nothing. If nothing needs changing, change nothing. Do not message anyone; end with finish_silently.`;

export interface MemoryTidyProfile {
  cronId?: string;
  managedSchedule?: CronSchedule;
  managedAction?: string;
}

export function createMemoryTidyService(deps: {
  store: DurableMap<MemoryTidyProfile>;
  memory: Pick<MemoryService, "metadata" | "facts">;
  timezone: (principalId: string) => Promise<string | undefined>;
  members: (scope: ScopeId) => Promise<Principal[] | undefined>;
  crons: CronStore;
  scheduler: Pick<Scheduler, "notifyChanged">;
}) {
  const same = (a: CronSchedule | undefined, b: CronSchedule | undefined) => JSON.stringify(a) === JSON.stringify(b);

  const scheduleFor = async (scope: ScopeId, owner: string): Promise<CronSchedule> => ({
    cron: `${createHash("sha256").update(scope).digest()[0]! % 60} 3 * * *`,
    timezone: (await deps.timezone(owner)) ?? DEFAULT_CRON_TIMEZONE,
  });

  async function maintainOne(scope: ScopeId): Promise<void> {
    const profile = await deps.store.get(scope);
    if (!profile?.cronId) {
      const { kind } = parseScopeId(scope);
      if (kind !== "personal" && kind !== "channel" && kind !== "group") return;
      const members = (await deps.members(scope))?.toSorted((a, b) => a.id.localeCompare(b.id));
      const owner = members?.[0]?.id;
      if (!owner) return;
      const schedule = await scheduleFor(scope, owner);
      const cron = await deps.crons.create({
        owner,
        createdBy: owner,
        ownerScopeId: scope,
        title: "Tidy memory",
        schedule,
        action: MEMORY_TIDY_TASK,
        ...(kind === "personal" ? { runAs: "owner" } : { runAs: "scopeFloor", members }),
      });
      await deps.store.put(scope, { cronId: cron.id, managedSchedule: schedule, managedAction: MEMORY_TIDY_TASK });
      deps.scheduler.notifyChanged(cron.id);
      return;
    }
    const cron = await deps.crons.get(profile.cronId);
    if (!cron || cron.ownerScopeId !== scope || cron.archived) return;
    const schedule = await scheduleFor(scope, cron.owner);
    if (cron.action === profile.managedAction && cron.action !== MEMORY_TIDY_TASK) {
      await deps.crons.update(cron.id, { action: MEMORY_TIDY_TASK });
      await deps.store.merge(scope, { managedAction: MEMORY_TIDY_TASK });
    }
    if (same(cron.schedule, profile.managedSchedule) && !same(cron.schedule, schedule)) {
      await deps.crons.update(cron.id, { schedule });
      await deps.store.merge(scope, { managedSchedule: schedule });
      deps.scheduler.notifyChanged(cron.id);
    }
  }

  return {
    async maintain(): Promise<void> {
      for (const scope of (await deps.memory.metadata?.())?.keys() ?? []) {
        await maintainOne(scope).catch((e: unknown) => reportFailure(`memory tidy: maintain ${scope}`, e));
      }
    },

    async skipFire(cron: Cron): Promise<string | undefined> {
      if (cron.action !== MEMORY_TIDY_TASK || !deps.memory.facts) return undefined;
      if ((await deps.store.get(cron.ownerScopeId))?.cronId !== cron.id) return undefined;
      const facts = await deps.memory.facts(cron.ownerScopeId);
      const changedAt = facts.reduce((latest, fact) => Math.max(latest, fact.updatedAt), 0);
      const { runs } = await deps.crons.listFires(cron.id, { limit: 10 });
      const tidied = runs.findLast((run) => run.status === "ok" || run.status === "silent");
      return changedAt > (tidied?.endedAt ?? tidied?.firedAt ?? 0)
        ? undefined
        : "notebook unchanged since the last tidy";
    },
  };
}
