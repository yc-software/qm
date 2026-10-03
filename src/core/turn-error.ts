import { headSlice } from "../util/text.ts";

export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableTurnError";
  }
}

export class ProviderTurnError extends Error {
  /** Provider-requested wait before retrying, when the error said so. */
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderTurnError";
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
};

/**
 * Reads a provider's requested retry delay out of an error message. Covers pi-ai's
 * "Server requested 120s retry delay" (raised when Retry-After exceeds its own cap) and
 * OpenAI/LiteLLM "try again in 1.5s" / "retry after 20 seconds" wording.
 */
export function retryAfterHintMs(message: string): number | undefined {
  const m =
    /server requested (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(message) ??
    /(?:try again|retry) (?:in|after) (\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)\b/i.exec(message);
  if (!m) return undefined;
  const raw = m[2]!.toLowerCase();
  const factor = UNIT_MS[raw] ?? UNIT_MS[raw.replace(/s$/, "")] ?? 1_000;
  const ms = Number(m[1]) * factor;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
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
