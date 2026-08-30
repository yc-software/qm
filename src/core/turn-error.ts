export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableTurnError";
  }
}

export type TurnFailurePayload = { kind: "turn_failure"; message: string };

export const STAGED_MESSAGE_APPROVAL_FAILURE = "Message approval turn failed.";
export const MESSAGE_APPROVAL_STAGE_FAILURE = "Draft approval could not be staged.";

const GENERIC_TURN_FAILURE = "That turn failed and couldn't be completed. The details are in the operator error log.";

export function turnFailureMessage(err: unknown): string {
  return err instanceof NonRetryableTurnError && err.message.trim() ? err.message : GENERIC_TURN_FAILURE;
}
