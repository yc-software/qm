import type { LlmCallUsage } from "../sessions/session-store.ts";
import type { AgentTurnInput, AgentTurnResult } from "./agent.ts";
import { bankGoalTurn, type GrindMeter } from "./goal.ts";
import { sumCacheUsage } from "./pi-messages.ts";
import type { TurnSession } from "./turn-session.ts";

export async function settleTurnGoal(
  { entry, turn, grindMeter }: { entry: TurnSession; turn: AgentTurnInput; grindMeter: GrindMeter },
  pause: boolean,
): Promise<void> {
  const g = entry.ref.goal;
  if (!g) return;
  bankGoalTurn(g, grindMeter.startedAt);
  if (pause && g.status === "active") {
    g.status = "paused";
    g.updatedAt = Date.now();
  }
  await turn.saveGoal?.(g);
  if (g.status === "complete") entry.ref.goal = null;
}

export function turnResult(
  {
    entry,
    callUsage,
    checked,
  }: { entry: TurnSession; callUsage: Array<LlmCallUsage | null>; checked: { retry: string[]; prod: string[] } },
  reply: string,
  extra: Partial<AgentTurnResult>,
): AgentTurnResult {
  const cacheUsage = sumCacheUsage(callUsage);
  return {
    reply,
    ...extra,
    ...(checked.retry.length ? { retracted: checked.retry } : {}),
    ...(checked.prod.length ? { prodded: checked.prod } : {}),
    modelCalls: entry.ref.modelCalls ?? 0,
    ...(cacheUsage ? { cacheUsage } : {}),
  };
}
