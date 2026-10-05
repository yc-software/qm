import { headSlice } from "../util/text.ts";

export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableTurnError";
  }
}

export class ProviderTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTurnError";
  }
}

export class TitleRejected extends Error {
  readonly rule: string;
  constructor(rule: string, sample: string) {
    super(`${rule}: ${JSON.stringify(headSlice(sample, 80))}`);
    this.name = "TitleRejected";
    this.rule = rule;
  }
}

export type TurnFailurePayload = { kind: "turn_failure"; message: string; runId?: string };

const GENERIC_TURN_FAILURE = "That turn failed and couldn't be completed. The details are in the operator error log.";

export function turnFailureMessage(err: unknown): string {
  return (err instanceof NonRetryableTurnError || err instanceof ProviderTurnError) && err.message.trim()
    ? err.message
    : GENERIC_TURN_FAILURE;
}

const MODEL_BUDGET_EXHAUSTED = /\bbudget_exceeded\b|\bExceededBudget\b|budget has been exceeded/i;

const BUDGET_PERIODS: Record<string, string> = { h: "hour", d: "day", w: "week", mo: "month" };
const SINGLE_PERIOD_ADJECTIVES: Record<string, string> = { h: "hourly", d: "daily", w: "weekly", mo: "monthly" };

function budgetPeriod(window: string | undefined): string {
  const match = window ? /^(\d+)(h|d|w|mo)$/.exec(window) : null;
  if (!match) return "";
  const [, count, unit] = match;
  return count === "1" ? `${SINGLE_PERIOD_ADJECTIVES[unit!]} ` : `${count}-${BUDGET_PERIODS[unit!]} `;
}

function budgetAmount(message: string): string {
  const limit = /(?:Limit=|Max budget: |Budget=)\$?([\d.]+)/.exec(message)?.[1];
  const usd = limit === undefined ? NaN : Number(limit);
  return Number.isFinite(usd) ? `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })} ` : "";
}

export function modelBudgetRefusal(message: string, note?: string): string | undefined {
  if (!MODEL_BUDGET_EXHAUSTED.test(message)) return undefined;
  const window = /\bover (\S+) budget\b/.exec(message)?.[1];
  const exhausted = `This workspace has used up its ${budgetAmount(message)}${budgetPeriod(window)}model budget, so I can't run until it resets.`;
  return `${exhausted} ${note ?? "An admin can raise the limit."}`;
}
