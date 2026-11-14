import { headSlice } from "../util/text.ts";
import type { NewItem } from "../sessions/items.ts";

export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableTurnError";
  }
}

export class HeldTurnError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "HeldTurnError";
    this.retryAfterMs = retryAfterMs;
  }
}

export type ProviderErrorCode =
  | "model_budget"
  | "rate_limit"
  | "refusal"
  | "auth"
  | "context_too_long"
  | "not_found"
  | "model_unavailable"
  | "bad_request"
  | "transient"
  | "unknown";

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

export class TransientTurnFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientTurnFailure";
  }
}

export class TurnHandedOff extends TransientTurnFailure {
  constructor(runId: string | undefined) {
    super(`turn ${runId ?? ""} was handed to a queue worker at shutdown; its fire will be re-driven`);
    this.name = "TurnHandedOff";
  }
}

export const TRANSIENT_ERROR_CODES: readonly ProviderErrorCode[] = ["rate_limit", "transient"];

export function isTransientErrorCode(code: string | undefined): boolean {
  return (TRANSIENT_ERROR_CODES as readonly (string | undefined)[]).includes(code);
}

export function isTransientFailure(err: unknown): boolean {
  return err instanceof TransientTurnFailure || (err instanceof ProviderTurnError && isTransientErrorCode(err.code));
}

export class TitleRejected extends Error {
  readonly rule: string;
  constructor(rule: string, sample: string) {
    super(`${rule}: ${JSON.stringify(headSlice(sample, 80))}`);
    this.name = "TitleRejected";
    this.rule = rule;
  }
}

export const turnFailureItem = (message: string, runId?: string): NewItem<"Error"> => ({
  kind: "Error",
  errorCode: "turn_failure",
  text: message,
  turnId: runId ?? null,
});

export const steerWithheldItem = (sender: string): NewItem<"Error"> => ({
  kind: "Error",
  errorCode: "steer_withheld",
  text: `A message from ${sender} arrived mid-turn and was withheld: security screening did not clear it.`,
});

const GENERIC_TURN_FAILURE = "That turn failed and couldn't be completed. The details are in the operator error log.";

export const MODEL_BUDGET_TEXT =
  "This workspace has used up its model budget, so I can't run until it resets. An admin can raise the limit.";

export function isNonRetryable(err: unknown): boolean {
  return err instanceof NonRetryableTurnError || (err instanceof ProviderTurnError && !err.retryable);
}

export function isModelBudget(err: unknown): err is ProviderTurnError {
  return err instanceof ProviderTurnError && err.code === "model_budget";
}

export function turnFailureMessage(err: unknown): string {
  if (isModelBudget(err)) return MODEL_BUDGET_TEXT;
  return (err instanceof NonRetryableTurnError || err instanceof ProviderTurnError) && err.message.trim()
    ? err.message
    : GENERIC_TURN_FAILURE;
}
