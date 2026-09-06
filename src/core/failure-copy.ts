import type { TurnResult } from "../types.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../../plugins/chassis/src/security-quarantine.ts";
import { GENERIC_FAILURE_CLAUSE, userFacingFailureText } from "../../plugins/chassis/src/failure-copy.ts";

export { userFacingFailureText } from "../../plugins/chassis/src/failure-copy.ts";

export const SESSION_BUSY_USER_TEXT =
  "Give me a moment — I'm still finishing something else in this conversation. Send that again in a minute and I'll pick it up.";

export const SESSION_BUSY_FIRE_TEXT =
  "I couldn't get to this one — the conversation was busy with another task, so this run was skipped.";

const SESSION_BUSY_CLAUSE = "the conversation was busy with another task";

interface FailureShape {
  status?: string;
  reason?: string;
  refusalKind?: TurnResult["refusalKind"];
}

export function standaloneFailureText(result: FailureShape): string | undefined {
  return result.refusalKind ? userFacingFailureText(result) : undefined;
}

export function userFacingFailureClause(result: FailureShape): string {
  if (result.refusalKind === "security_quarantine") return SECURITY_QUARANTINE_REFUSAL_TEXT;
  if (result.refusalKind === "session_busy") return SESSION_BUSY_CLAUSE;
  if (result.status === "failed" || !result.reason) return GENERIC_FAILURE_CLAUSE;
  return result.reason;
}
