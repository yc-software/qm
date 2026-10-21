import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { hashId } from "../util/crypto.ts";

export function commandApprovalId(sessionId: string, command: string, approvalKey?: string): string {
  return hashId(approvalKey ? [sessionId, command, approvalKey] : [sessionId, command]);
}

export function inputApprovalId(sessionId: string, request: unknown): string {
  return hashId([sessionId, "security-screen", JSON.stringify(request ?? null)]);
}

export function toolCallApprovalKey(tool: string, params: unknown): string {
  return `tool-call:${hashId([tool, canonicalJson(params ?? null)], 64)}`;
}
