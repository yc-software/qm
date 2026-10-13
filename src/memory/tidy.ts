import type { DurableMap } from "../persistence/durable-map.ts";
import type { CronStore } from "../cron/cron-store.ts";
import { claimManagedCron, nightlyAt } from "../cron/managed.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import { DEFAULT_CRON_TIMEZONE } from "../cron/schedule.ts";
import { reportFailure } from "../util/errors.ts";
import { parseScopeId, scopeActor, type Cron, type ScopeId } from "../types.ts";
import type { MemoryService } from "./memory-service.ts";

const MEMORY_TIDY_TASK = `Tidy this conversation's memory notebook. Read it with the memory tool, then make one careful pass:
- Merge duplicates and near-duplicates: edit the oldest of them into the single best wording and delete the rest. Only merge facts that carry the same "(said in …)" tag, or none.
- Delete facts that are stale, superseded by a newer fact, or one-off trivia. When a newer fact corrects an older one, keep one fact that states the current truth.
- Never reword a directive or anything quoted in someone's own words, and keep every "(said in …)" tag exactly as written. Delete one only when it exactly duplicates another or a newer fact explicitly replaces it.
- Move growing operational lists (queues, status logs, ID lists, per-item progress) without a "(said in …)" tag into a durable Files upload, then replace those facts with one fact naming the file's Files id and what it holds. First check sandbox list: if there is no default computer, skip this step; never create a computer or change the default. If the upload doesn't return an id, leave those facts as they are.
- Add no new information and leave every other notebook alone.
Batch your edits and deletes into list calls; each call changes everything or nothing. If nothing needs changing, change nothing. Do not message anyone; end with finish_silently.`;

export interface MemoryTidyProfile {
  cronId?: string;
}

export function createMemoryTidyService(deps: {
  store: DurableMap<MemoryTidyProfile>;
  memory: Pick<MemoryService, "facts">;
  timezone: (principalId: string) => Promise<string | undefined>;
  crons: CronStore;
  scheduler: Pick<Scheduler, "notifyChanged">;
}) {
  return {
    async ensure(scope: ScopeId): Promise<void> {
      const { kind, ref } = parseScopeId(scope);
      if (kind !== "personal" && kind !== "channel" && kind !== "group") return;
      if ((await deps.store.get(scope))?.cronId) return;
      const owner = kind === "personal" ? ref : scopeActor(scope);
      await claimManagedCron(
        deps,
        scope,
        {},
        {
          owner,
          createdBy: owner,
          ownerScopeId: scope,
          title: "Tidy memory",
          schedule: {
            cron: nightlyAt(scope, 3),
            timezone: (kind === "personal" && (await deps.timezone(ref))) || DEFAULT_CRON_TIMEZONE,
          },
          action: MEMORY_TIDY_TASK,
          runAs: kind === "personal" ? "owner" : "scope",
        },
      );
    },

    async skipFire(cron: Cron): Promise<string | undefined> {
      if (!deps.memory.facts || (await deps.store.get(cron.ownerScopeId))?.cronId !== cron.id) return undefined;
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

export function withMemoryTidy(memory: MemoryService, ensure: (scope: ScopeId) => Promise<void>): MemoryService {
  return {
    ...memory,
    ...(memory.withDisclosure
      ? { withDisclosure: (access) => withMemoryTidy(memory.withDisclosure!(access), ensure) }
      : {}),
    async capture(scope, ...rest) {
      const added = await memory.capture(scope, ...rest);
      if (added > 0) await ensure(scope).catch((e: unknown) => reportFailure(`memory tidy: ensure ${scope}`, e));
      return added;
    },
  };
}
