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

const CONNECTOR_TOOL_GRANT_PREFIX = "connector-tool:";
const CONNECTOR_TOOL_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

function catalogInnerTool(params: unknown): string | undefined {
  return isObj(params) && params.operation === "invoke" && typeof params.tool === "string" ? params.tool : undefined;
}

export function connectorToolName(tool: string, params: unknown): string {
  return catalogInnerTool(params) ?? tool;
}

export function connectorToolGrantKey(tool: string, params: unknown): string {
  const inner = catalogInnerTool(params);
  return `${CONNECTOR_TOOL_GRANT_PREFIX}${hashId(inner === undefined ? [tool] : [tool, inner], 64)}`;
}

export function connectorToolGrantLapsed(grant: { approvalKey?: string; createdAt: number }, now: number): boolean {
  return (
    grant.approvalKey?.startsWith(CONNECTOR_TOOL_GRANT_PREFIX) === true &&
    now - grant.createdAt >= CONNECTOR_TOOL_GRANT_TTL_MS
  );
}

export function approvalCardId(callKey: string): string {
  return callKey.slice(TOOL_CALL_APPROVAL_PREFIX.length, TOOL_CALL_APPROVAL_PREFIX.length + 12);
}

export function approvedCallId(requestId: string, issuedAt: number): string {
  return `approved_${requestId}_${issuedAt}`;
}
