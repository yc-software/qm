import type { WorkBlock } from "./core-bridge";

function activityTimes(work: WorkBlock): number[] {
  return work.activity.map((a) => a.createdAt).filter((t): t is number => typeof t === "number" && t > 0);
}

export function workStartedAt(work: WorkBlock): number | null {
  if (work.startedAt != null) return work.startedAt;
  const times = activityTimes(work);
  return times.length ? Math.min(...times) : null;
}

export function workSeconds(work: WorkBlock): number {
  const start = workStartedAt(work);
  if (start == null) return 0;
  const live = work.status === "thinking" || work.status === "working";
  const end = work.finishedAt ?? (live ? Date.now() : Math.max(start, ...activityTimes(work)));
  return Math.max(0, Math.round((end - start) / 1000));
}

export function workedLabel(prefix: string, secs: number): string {
  return secs > 0 ? `${prefix} for ${secs}s` : prefix;
}

export function elapsedLabel(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const secs = Math.floor(tenths / 10);
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}
