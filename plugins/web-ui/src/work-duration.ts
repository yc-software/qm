import { currentTextPhase } from "./timeline.ts";
import { goalElapsedLabel } from "./goal-strip.ts";
import { workPausedForApproval, type WorkBlock } from "./core-bridge.ts";

export function workSeconds(work: WorkBlock): number {
  const times = work.activity.map((a) => a.createdAt).filter((t) => typeof t === "number" && t > 0);
  const start = work.startedAt ?? (times.length ? Math.min(...times) : null);
  if (start == null) return 0;
  const live = work.status === "thinking" || work.status === "working";
  const phase = currentTextPhase(work);
  const last = work.activity.at(-1);
  let end = workPausedForApproval(work) ? last!.createdAt : work.finishedAt;
  if (phase?.phase === "final_answer") end = phase.startedAt;
  if (end == null) {
    if (live) end = Date.now();
    else end = times.length ? Math.max(...times, start) : start;
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

export function workedLabel(prefix: string, secs: number): string {
  return secs > 0 ? `${prefix} for ${goalElapsedLabel(0, secs * 1000)}` : prefix;
}
