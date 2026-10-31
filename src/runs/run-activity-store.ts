export interface RunActivityEntry {
  seq: number;
  parentSeq: number | null;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface RunActivityStore {
  append(runId: string, entry: RunActivityEntry): Promise<void>;
  list(runId: string): Promise<RunActivityEntry[]>;
  close?(): Promise<void>;
}

export const RUN_ACTIVITY_TTL_MS = 60 * 60_000;
