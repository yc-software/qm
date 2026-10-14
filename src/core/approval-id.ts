import { canonicalJson } from "../util/objects.ts";
import { hashId } from "../util/crypto.ts";

export function commandApprovalId(sessionId: string, command: string): string {
  return hashId([sessionId, command]);
}

export function inputApprovalId(sessionId: string, request: unknown): string {
  return hashId([sessionId, "security-screen", JSON.stringify(request ?? null)]);
}

export function toolCallApprovalKey(tool: string, params: unknown): string {
  return `tool-call:${hashId([tool, canonicalJson(params)], 64)}`;
}
