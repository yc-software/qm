import { headSlice } from "../util/text.ts";

export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableTurnError";
  }
}

export type ProviderErrorCode =
  "model_budget" | "rate_limit" | "refusal" | "auth" | "context_too_long" | "transient" | "unknown";

export class ProviderTurnError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly raw: string;
  constructor(
    message: string,
    info: { code: ProviderErrorCode; retryable: boolean; status?: number | undefined; raw: string },
  ) {
    super(message);
    this.name = "ProviderTurnError";
    this.code = info.code;
    this.retryable = info.retryable;
    if (info.status !== undefined) this.status = info.status;
    this.raw = info.raw;
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

export const MODEL_BUDGET_TEXT =
  "This workspace has used up its model budget, so I can't run until it resets. An admin can raise the limit.";

export function isModelBudget(err: unknown): err is ProviderTurnError {
  return err instanceof ProviderTurnError && err.code === "model_budget";
}

export function turnFailureMessage(err: unknown): string {
  if (isModelBudget(err)) return MODEL_BUDGET_TEXT;
  return (err instanceof NonRetryableTurnError || err instanceof ProviderTurnError) && err.message.trim()
    ? err.message
    : GENERIC_TURN_FAILURE;
}
