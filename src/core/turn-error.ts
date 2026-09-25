import { headSlice } from "../util/text.ts";

export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableTurnError";
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
  return err instanceof NonRetryableTurnError && err.message.trim() ? err.message : GENERIC_TURN_FAILURE;
}
