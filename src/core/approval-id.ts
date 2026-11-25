import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { hashId } from "../util/crypto.ts";

export function commandApprovalId(
  sessionId: string,
  runId: string | undefined,
  command: string,
  approvalKey?: string,
): string {
  return hashId([sessionId, runId ?? "", command, approvalKey ?? ""]);
}

export function inputApprovalId(sessionId: string, request: unknown): string {
  return hashId([sessionId, "security-screen", canonicalJson(request ?? null)]);
}

const TOOL_CALL_APPROVAL_PREFIX = "tool-call:";

export function toolCallApprovalKey(tool: string, params: unknown): string {
  return `${TOOL_CALL_APPROVAL_PREFIX}${hashId([tool, canonicalJson(params ?? null)], 64)}`;
}

export function approvalCardId(callKey: string): string {
  return callKey.slice(TOOL_CALL_APPROVAL_PREFIX.length, TOOL_CALL_APPROVAL_PREFIX.length + 12);
}

export function approvedCallId(requestId: string, issuedAt: number): string {
  return `approved_${requestId}_${issuedAt}`;
}
