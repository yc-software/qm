import type { Item } from "../sessions/items.ts";
export type RunActivityEntry =
  | { item: Item }
  | { marker: "text_start"; seq: number; createdAt: number; phase?: string; streamOffset?: number }
  | { marker: "sandbox_status"; seq: number; createdAt: number; text: string };

export const activityCreatedAt = (entry: RunActivityEntry): number =>
  "item" in entry ? entry.item.createdAt : entry.createdAt;

export interface RunActivityStore {
  append(runId: string, entry: RunActivityEntry): Promise<void>;
  list(runId: string): Promise<RunActivityEntry[]>;
  close?(): Promise<void>;
}

export const RUN_ACTIVITY_TTL_MS = 60 * 60_000;
const MAX_PER_RUN = 2_000;
const PRUNE_INTERVAL_MS = 60_000;

export function createMemoryRunActivityStore(now: () => number = Date.now): RunActivityStore {
  const runs = new Map<string, RunActivityEntry[]>();
  let nextPruneAt = Number.NEGATIVE_INFINITY;
  return {
    async append(runId, entry) {
      const t = now();
      if (t >= nextPruneAt) {
        nextPruneAt = t + PRUNE_INTERVAL_MS;
        const cutoff = t - RUN_ACTIVITY_TTL_MS;
        for (const [id, list] of runs) {
          const kept = list.filter((e) => activityCreatedAt(e) >= cutoff);
          if (kept.length) runs.set(id, kept);
          else runs.delete(id);
        }
      }
      const list = runs.get(runId) ?? [];
      if (list.length < MAX_PER_RUN) list.push(entry);
      runs.set(runId, list);
    },
    async list(runId) {
      return (runs.get(runId) ?? []).slice();
    },
  };
}
