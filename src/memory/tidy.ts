import { createHash } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { CronStore } from "../cron/cron-store.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import { DEFAULT_CRON_TIMEZONE } from "../cron/schedule.ts";
import { parseScopeId, scopeId, type Cron, type CronSchedule, type ScopeId } from "../types.ts";

export const MEMORY_TIDY_TASK = `Tidy your memory notebook for this person. Read it with the memory tool, then make one careful pass:
- Merge duplicates and near-duplicates: edit the oldest of them into the single best wording and delete the rest. Only merge facts that carry the same "(said in …)" tag, or none.
- Delete facts that are stale, superseded by a newer fact, or one-off trivia. When a newer fact corrects an older one, keep one fact that states the current truth.
- Never reword a directive or anything quoted in the person's own words, and keep every "(said in …)" tag exactly as written. You may delete an exact duplicate of either.
- Move growing operational lists (queues, status logs, ID lists, per-item progress) into a file with the files tool, confirm it saved, then replace those facts with one fact naming the file and what it holds.
- Add no new information and leave every other notebook alone.
Batch your edits and deletes into list calls; each call changes everything or nothing. If nothing needs changing, change nothing. Do not message anyone; end with finish_silently.`;

export interface MemoryTidyProfile {
  cronId?: string;
  managedSchedule?: CronSchedule;
  managedAction?: string;
  autoPaused?: boolean;
}

export function createMemoryTidyService(deps: {
  store: DurableMap<MemoryTidyProfile>;
  notebooks: () => Promise<Map<ScopeId, { updatedAt?: number }>>;
  timezone: (principalId: string) => Promise<string | undefined>;
  crons: CronStore;
  scheduler: Pick<Scheduler, "notifyChanged">;
}) {
  const same = (a: CronSchedule | undefined, b: CronSchedule | undefined) => JSON.stringify(a) === JSON.stringify(b);
  const owned = (cron: Cron | null, principalId: string): cron is Cron =>
    !!cron && cron.owner === principalId && cron.ownerScopeId === scopeId("personal", principalId);

  async function maintainOne(principalId: string, updatedAt: number): Promise<void> {
    const schedule: CronSchedule = {
      cron: `${createHash("sha256").update(principalId).digest()[0]! % 60} 3 * * *`,
      timezone: (await deps.timezone(principalId)) ?? DEFAULT_CRON_TIMEZONE,
    };
    const profile = await deps.store.putIfAbsent(principalId, {});
    if (!profile.cronId) {
      if (!updatedAt) return;
      const cron = await deps.crons.create({
        owner: principalId,
        createdBy: principalId,
        ownerScopeId: scopeId("personal", principalId),
        title: "Tidy my memory",
        schedule,
        runAs: "owner",
        action: MEMORY_TIDY_TASK,
      });
      const stored = await deps.store.update?.(principalId, (value) =>
        value.cronId ? value : { cronId: cron.id, managedSchedule: schedule, managedAction: MEMORY_TIDY_TASK },
      );
      if (!stored) throw new Error("Memory tidy requires an atomic profile store");
      if (stored.cronId !== cron.id) await deps.crons.setEnabled(cron.id, false);
      deps.scheduler.notifyChanged(stored.cronId!);
      return;
    }
    const cron = await deps.crons.get(profile.cronId);
    if (!owned(cron, principalId) || cron.archived) return;
    if (cron.action === profile.managedAction && cron.action !== MEMORY_TIDY_TASK) {
      await deps.crons.update(cron.id, { action: MEMORY_TIDY_TASK });
      await deps.store.merge(principalId, { managedAction: MEMORY_TIDY_TASK });
    }
    if (same(cron.schedule, profile.managedSchedule) && !same(cron.schedule, schedule)) {
      await deps.crons.update(cron.id, { schedule });
      await deps.store.merge(principalId, { managedSchedule: schedule });
      deps.scheduler.notifyChanged(cron.id);
    }
    const { runs } = await deps.crons.listFires(cron.id, { limit: 10 });
    if (runs.at(-1)?.status === "running") return;
    const tidied = runs.findLast((run) => run.status === "ok" || run.status === "silent");
    const changed = updatedAt > (tidied?.endedAt ?? tidied?.firedAt ?? 0);
    if (!changed && cron.enabled) {
      await deps.crons.setEnabled(cron.id, false);
      await deps.store.merge(principalId, { autoPaused: true });
    } else if (changed && profile.autoPaused) {
      await deps.crons.setEnabled(cron.id, true);
      await deps.store.merge(principalId, { autoPaused: false });
      deps.scheduler.notifyChanged(cron.id);
    }
  }

  return {
    async maintain(): Promise<void> {
      const principals = new Map((await deps.store.entries()).map(([principalId]) => [principalId, 0]));
      for (const [scope, { updatedAt }] of await deps.notebooks()) {
        const { kind, ref } = parseScopeId(scope);
        if (kind === "personal" && ref) principals.set(ref, updatedAt ?? 0);
      }
      for (const [principalId, updatedAt] of principals) await maintainOne(principalId, updatedAt);
    },
  };
}
