import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "./security-quarantine.ts";

export const GENERIC_FAILURE_CLAUSE = "something went wrong on my end";

export const GENERIC_FAILURE_TEXT = "Something went wrong on my end and I couldn't finish that. Try again in a moment.";

export interface FailureLike {
  status?: string;
  reason?: string;
  refusalKind?: string;
}

export function userFacingFailureText(result: FailureLike): string {
  if (result.refusalKind === "security_quarantine") return SECURITY_QUARANTINE_REFUSAL_TEXT;
  if (result.status === "refused" && result.reason) return result.reason;
  return GENERIC_FAILURE_TEXT;
}
