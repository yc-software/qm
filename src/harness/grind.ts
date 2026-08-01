import type { LlmCallUsage } from "../sessions/session-store.ts";

export interface GrindBudget {
  minTurns?: number;
  minMs?: number;
  minTokens?: number;
  minUsd?: number;
  clampedMs?: boolean;
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

export interface GrindStopProgress {
  attempts: number;
  toolCalls: number;
}

export interface GrindContinuationResult<T> {
  outcome: T;
  waiverNote: string;
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

export function parseGrindDirective(text: string): { input: string; grind?: GrindBudget } {
  if (!text.startsWith("/grind")) return { input: text };
  const boundary = text[6];
  if (boundary !== " " && boundary !== "\t") return { input: text };
  const rest = text.slice(7).trimStart();
  const grind: GrindBudget = {};
  let cursor = 0;
  let consumed = 0;
  while (cursor < rest.length) {
    const match = rest.slice(cursor).match(/^(?:(\d+)([tmhk])|\$(\d+(?:\.\d+)?))(?=\s|$)/);
    if (!match) break;
    const amount = Number(match[1] ?? match[3]);
    const unit = match[2];
    if (unit === "t") grind.minTurns = Math.max(grind.minTurns ?? 0, amount);
    else if (unit === "m") grind.minMs = Math.max(grind.minMs ?? 0, amount * 60_000);
    else if (unit === "h") grind.minMs = Math.max(grind.minMs ?? 0, amount * 3_600_000);
    else if (unit === "k") grind.minTokens = Math.max(grind.minTokens ?? 0, amount * 1000);
    else grind.minUsd = Math.max(grind.minUsd ?? 0, amount);
    consumed++;
    cursor += match[0].length;
    const separator = rest.slice(cursor).match(/^\s+/)?.[0];
    if (!separator) break;
    cursor += separator.length;
  }
  if (!consumed || Object.values(grind).some((value) => !Number.isFinite(value) || value <= 0)) return { input: text };
  let input = rest.slice(cursor);
  if (input.startsWith("—")) input = input.slice(1).replace(/^\s+/, "");
  return { input, grind };
}

export function clampGrindBudget(grind: GrindBudget, turnWallClockMs: number | undefined): GrindBudget {
  if (!grind.minMs || !turnWallClockMs || turnWallClockMs <= 0 || grind.minMs <= turnWallClockMs) return grind;
  return { ...grind, minMs: turnWallClockMs, clampedMs: true };
}

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

export function grindNudge(state: GrindState, clamped: boolean): string {
  const clamp = clamped ? " Wall-clock floor was clamped to the turn ceiling." : "";
  return `[grind] Budget floor not met: ${state.text}.${clamp} Do not summarize or conclude; go deeper on the least-examined area.`;
}

export function hasGrindWaiver(text: string): boolean {
  return /^\[grind-waived:\s*[^\]\n]+\]/m.test(text);
}

export function grindStopProgress(
  progress: GrindStopProgress,
  toolCalls: number,
): GrindStopProgress & { waive: boolean } {
  const attempts = (toolCalls > progress.toolCalls ? 0 : progress.attempts) + 1;
  return { attempts, toolCalls, waive: attempts >= 5 };
}

export async function enforceGrindBudget<T>(opts: {
  grind: GrindBudget;
  meter: GrindMeter;
  outcome: T;
  ok: T;
  closingText(): string;
  toolCalls(): number;
  blocked(): boolean;
  beforePrompt(note: string): void | Promise<void>;
  prompt(note: string): Promise<T>;
}): Promise<GrindContinuationResult<T>> {
  let outcome = opts.outcome;
  let progress = { attempts: 0, toolCalls: 0 };
  let firstContinuation = true;
  while (outcome === opts.ok && !opts.blocked()) {
    if (hasGrindWaiver(opts.closingText())) break;
    const state = grindState(opts.grind, opts.meter);
    if (state.met) break;
    const stop = grindStopProgress(progress, opts.toolCalls());
    progress = stop;
    if (stop.waive) {
      return { outcome, waiverNote: "[grind waived: agent made no progress after 5 nudges]" };
    }
    const note = grindNudge(state, opts.grind.clampedMs === true && firstContinuation);
    firstContinuation = false;
    await opts.beforePrompt(note);
    outcome = await opts.prompt(note);
  }
  return { outcome, waiverNote: "" };
}

function formatDuration(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(2)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(2)}m`;
  return `${Math.round(ms / 1000)}s`;
}
