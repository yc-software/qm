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
  startedAt: number;
}

export interface GrindState {
  met: boolean;
  text: string;
}

const MODEL_USD_PER_MILLION_TOKENS: ReadonlyArray<[RegExp, number]> = [
  [/opus/i, 15],
  [/sonnet/i, 3],
  [/haiku/i, 0.8],
  [/gpt-5/i, 5],
  [/o3/i, 10],
  [/o4-mini/i, 2],
  [/gemini.*pro/i, 3.5],
  [/gemini.*flash/i, 0.5],
];

const DEFAULT_USD_PER_MILLION_TOKENS = 5;

export function createGrindMeter(startedAt = Date.now()): GrindMeter {
  return { turns: 0, tokens: 0, usd: 0, startedAt };
}

export function meterGrindCall(meter: GrindMeter, usage: LlmCallUsage | null, model: string): void {
  meter.turns++;
  const tokens = Math.max(0, (usage?.input ?? 0) + (usage?.output ?? 0));
  meter.tokens += tokens;
  const price =
    MODEL_USD_PER_MILLION_TOKENS.find(([pattern]) => pattern.test(model))?.[1] ?? DEFAULT_USD_PER_MILLION_TOKENS;
  meter.usd += (tokens * price) / 1_000_000;
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
  if (grind.minUsd !== undefined) {
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
