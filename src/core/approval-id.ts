import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { hashId } from "../util/crypto.ts";
import { isObj } from "../util/objects.ts";

export function commandApprovalId(sessionId: string, command: string, approvalKey?: string): string {
  return hashId(approvalKey ? [sessionId, command, approvalKey] : [sessionId, command]);
}

export function inputApprovalId(sessionId: string, request: unknown): string {
  return hashId([sessionId, "security-screen", canonicalJson(request ?? null)]);
}

const TOOL_CALL_APPROVAL_PREFIX = "tool-call:";

export function toolCallApprovalKey(tool: string, params: unknown): string {
  return `${TOOL_CALL_APPROVAL_PREFIX}${hashId([tool, canonicalJson(params ?? null)], 64)}`;
}

export function connectorToolName(tool: string, params: unknown): string {
  return isObj(params) && params.operation === "invoke" && typeof params.tool === "string" ? params.tool : tool;
}

export function connectorToolGrantKey(tool: string, grantTool: string): string {
  return `connector-tool:${hashId([tool, grantTool], 64)}`;
}

export function approvalCardId(callKey: string): string {
  return callKey.slice(TOOL_CALL_APPROVAL_PREFIX.length, TOOL_CALL_APPROVAL_PREFIX.length + 12);
}

export function approvedCallId(requestId: string, issuedAt: number): string {
  return `approved_${requestId}_${issuedAt}`;
}
