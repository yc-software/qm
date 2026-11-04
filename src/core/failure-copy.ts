import type { TurnResult } from "../types.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../../plugins/chassis/src/security-quarantine.ts";
import { GENERIC_FAILURE_CLAUSE, userFacingFailureText } from "../../plugins/chassis/src/failure-copy.ts";

interface FailureShape {
  status?: string;
  reason?: string;
  refusalKind?: TurnResult["refusalKind"];
}

export function standaloneFailureText(result: FailureShape): string | undefined {
  return result.refusalKind ? userFacingFailureText(result) : undefined;
}

export function unfinishedTurnText(clause: string): string {
  return `⚠️ I couldn't finish that turn: ${clause}`;
}

export function userFacingFailureClause(result: FailureShape): string {
  if (result.refusalKind === "security_quarantine") return SECURITY_QUARANTINE_REFUSAL_TEXT;
  if (result.status === "failed" || !result.reason) return GENERIC_FAILURE_CLAUSE;
  return result.reason;
}
