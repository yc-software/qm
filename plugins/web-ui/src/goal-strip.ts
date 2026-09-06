export interface GoalStripState {
  objective: string;
  status: "active" | "paused" | "complete" | "blocked";
  floor?: string;
  createdAt: number;
}

interface ActivityLike {
  type?: string;
  payload?: unknown;
}

interface MessageLike {
  work?: { activity?: ActivityLike[] };
}

const GOAL_TOOLS = new Set(["create_goal", "update_goal", "get_goal"]);

function snapshotFrom(payload: unknown): GoalStripState | null | undefined {
  const p = payload as { tool?: unknown; goal?: unknown } | null;
  if (!p || typeof p !== "object" || typeof p.tool !== "string" || !GOAL_TOOLS.has(p.tool)) return undefined;
  if (!("goal" in p)) return undefined;
  if (p.goal === null) return null;
  const goal = p.goal as {
    objective?: unknown;
    status?: unknown;
    floor?: Record<string, unknown> | null;
    createdAt?: unknown;
  };
  if (typeof goal !== "object" || typeof goal.objective !== "string" || !goal.objective.trim()) return undefined;
  const status = goal.status;
  if (status !== "active" && status !== "paused" && status !== "complete" && status !== "blocked") return undefined;
  const floor = goalFloorLabel(goal.floor ?? null);
  return {
    objective: goal.objective,
    status,
    ...(floor ? { floor } : {}),
    createdAt: typeof goal.createdAt === "number" ? goal.createdAt : Date.now(),
  };
}

export function latestGoal(messages: readonly unknown[]): GoalStripState | null {
  let latest: GoalStripState | null = null;
  for (const message of messages) {
    const activity = (message as MessageLike).work?.activity;
    if (!activity) continue;
    for (const item of activity) {
      if (item?.type !== "tool_result") continue;
      const snap = snapshotFrom(item.payload);
      if (snap !== undefined) latest = snap;
    }
  }
  return latest;
}

export function goalFloorLabel(floor: Record<string, unknown> | null): string | null {
  if (!floor || typeof floor !== "object") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const parts: string[] = [];
  const ms = num(floor.minMs);
  if (ms !== null) parts.push(goalElapsedLabel(0, ms));
  const turns = num(floor.minTurns);
  if (turns !== null) parts.push(`${turns} turns`);
  const tokens = num(floor.minTokens);
  if (tokens !== null) parts.push(`${tokens.toLocaleString()} tokens`);
  const usd = num(floor.minUsd);
  if (usd !== null) parts.push(`$${usd}`);
  return parts.length ? parts.join(", ") : null;
}

export function goalElapsedLabel(startedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function goalObjectiveLabel(objective: string, max = 120): string {
  const oneLine = objective
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
