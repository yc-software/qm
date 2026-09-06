import type { WorkBlock } from "./core-bridge";

export function workSeconds(work: WorkBlock): number {
  const times = work.activity.map((a) => a.createdAt).filter((t) => typeof t === "number" && t > 0);
  const start = work.startedAt ?? (times.length ? Math.min(...times) : null);
  if (start == null) return 0;
  const live = work.status === "thinking" || work.status === "working";
  let end = work.finishedAt;
  if (end == null) {
    if (live) end = Date.now();
    else end = times.length ? Math.max(...times, start) : start;
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

export function workedLabel(prefix: string, secs: number): string {
  return secs > 0 ? `${prefix} for ${secs}s` : prefix;
}
