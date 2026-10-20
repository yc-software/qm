export interface GoalStripState {
  objective: string;
  status: "active" | "paused" | "complete" | "cancelled";
  floor?: string;
  createdAt: number;
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

export function goalWorkedLabel(workedMs: number, floor?: string | null): string {
  const worked = `${goalElapsedLabel(0, workedMs)} worked`;
  return floor ? `${worked} · ${floor} floor` : worked;
}
