import type { CronFireLogEntry } from "../types.ts";

export const CRON_FIRE_LOG_LIMIT = 100;

export interface CronFireLogStore {
  list(cronIds: string[]): Promise<Map<string, CronFireLogEntry[]>>;
  record(cronId: string, entry: CronFireLogEntry): Promise<void>;
  delete(cronId: string): Promise<void>;
}

export function mergeCronFireLogs(...logs: Array<readonly CronFireLogEntry[]>): CronFireLogEntry[] {
  const byKey = new Map<string, CronFireLogEntry>();
  for (const log of logs) {
    for (const entry of log) byKey.set(entry.fireKey, { ...byKey.get(entry.fireKey), ...entry });
  }
  return [...byKey.values()].sort((a, b) => a.firedAt - b.firedAt).slice(-CRON_FIRE_LOG_LIMIT);
}
