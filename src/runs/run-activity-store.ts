import type { Item } from "../sessions/items.ts";

export type RunActivityEntry =
  { item: Item } | { marker: "text_start"; seq: number; createdAt: number; phase?: string; streamOffset?: number };

export interface RunActivityStore {
  append(runId: string, entry: RunActivityEntry): Promise<void>;
  list(runId: string): Promise<RunActivityEntry[]>;
  close?(): Promise<void>;
}

export const RUN_ACTIVITY_TTL_MS = 60 * 60_000;
