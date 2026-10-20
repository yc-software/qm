import type { LlmCallUsage } from "../sessions/session-store.ts";

export interface GrindBudget {
  minTurns?: number;
  minMs?: number;
  minTokens?: number;
  minUsd?: number;
}

export interface GrindMeter {
  turns: number;
  tokens: number;
  usd: number;
  unpricedCalls: number;
  startedAt: number;
}

export interface GrindState {
  met: boolean;
  text: string;
}

export function createGrindMeter(startedAt = Date.now()): GrindMeter {
  return { turns: 0, tokens: 0, usd: 0, unpricedCalls: 0, startedAt };
}

export function meterGrindCall(meter: GrindMeter, usage: LlmCallUsage | null): void {
  meter.turns++;
  meter.tokens += Math.max(0, (usage?.input ?? 0) + (usage?.output ?? 0));
  meterGrindSpend(meter, usage);
}

export function meterGrindSpend(meter: GrindMeter, usage: LlmCallUsage | null): void {
  if (!usage) return;
  if (usage.costUsd > 0) meter.usd += usage.costUsd;
  else if (usage.input + usage.output > 0) meter.unpricedCalls++;
}

export function grindState(grind: GrindBudget, meter: GrindMeter, now = Date.now()): GrindState {
  const values: string[] = [];
  let met = true;
  if (grind.minTurns !== undefined) {
    met &&= meter.turns >= grind.minTurns;
    values.push(`${meter.turns}/${grind.minTurns} turns`);
  }
  if (grind.minMs !== undefined) {
    const elapsed = Math.max(0, now - meter.startedAt);
    met &&= elapsed >= grind.minMs;
    values.push(`${formatDuration(elapsed)}/${formatDuration(grind.minMs)}`);
  }
  if (grind.minTokens !== undefined) {
    met &&= meter.tokens >= grind.minTokens;
    values.push(`${meter.tokens}/${grind.minTokens} tokens`);
  }
  if (grind.minUsd !== undefined && meter.unpricedCalls > 0) {
    values.push(
      `$${grind.minUsd} spend floor waived: a model call during this goal had no price data, so spend cannot be measured`,
    );
  } else if (grind.minUsd !== undefined) {
    met &&= Math.round(meter.usd * 1_000_000) >= Math.round(grind.minUsd * 1_000_000);
    values.push(`$${meter.usd.toFixed(4)}/$${grind.minUsd}`);
  }
  return { met, text: values.join(", ") };
}

function formatDuration(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(2)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(2)}m`;
  return `${Math.round(ms / 1000)}s`;
}
