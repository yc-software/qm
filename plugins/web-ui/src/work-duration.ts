import { currentTextPhase } from "./timeline.ts";
import type { GoalStripState } from "./goal-strip.ts";
import { workPausedForApproval, type WorkBlock } from "./core-bridge.ts";
import { activityCreatedAt } from "./items.ts";

export function workSeconds(work: WorkBlock): number {
  const times = work.activity.map(activityCreatedAt).filter((t) => typeof t === "number" && t > 0);
  const start = work.startedAt ?? (times.length ? Math.min(...times) : null);
  if (start == null) return 0;
  const live = work.status === "thinking" || work.status === "working";
  const phase = currentTextPhase(work);
  const last = work.activity.at(-1);
  let end = workPausedForApproval(work) ? activityCreatedAt(last!) : work.finishedAt;
  if (phase?.phase === "final_answer") end = phase.startedAt;
  if (end == null) {
    if (live) end = Date.now();
    else end = times.length ? Math.max(...times, start) : start;
  }
  return Math.max(0, (end - start) / 1000);
}

export function workDurationParts(secs: number): { lead: string; seconds: number } {
  const whole = Math.max(0, Math.floor(secs));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  if (hours) return { lead: `${hours}h ${minutes}m `, seconds };
  return { lead: minutes ? `${minutes}m ` : "", seconds };
}

function workDuration(secs: number): string {
  const { lead, seconds } = workDurationParts(secs);
  return `${lead}${seconds}s`;
}

export function workedLabel(prefix: string, secs: number): string {
  return secs > 0 ? `${prefix} for ${workDuration(secs)}` : prefix;
}

interface GoalTurn {
  role?: string;
  work?: WorkBlock;
}

export function goalWorked(messages: readonly unknown[], goal: GoalStripState): number {
  let workedMs = 0;
  let counting = false;
  for (const m of messages as readonly GoalTurn[]) {
    const work = m.role === "assistant" ? m.work : undefined;
    if (!work) continue;
    const times = work.activity.map(activityCreatedAt).filter((t) => typeof t === "number" && t > 0);
    const start = work.startedAt ?? (times.length ? Math.min(...times) : undefined);
    if (!counting) {
      if (start === undefined || (work.finishedAt ?? Infinity) < goal.createdAt) continue;
      counting = true;
      workedMs -= Math.max(0, goal.createdAt - start);
    }
    workedMs += workSeconds(work) * 1000;
  }
  return Math.max(0, workedMs);
}
