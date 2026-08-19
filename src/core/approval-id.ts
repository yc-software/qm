import { hashId } from "../util/crypto.ts";

export function commandApprovalId(sessionId: string, command: string): string {
  return hashId([sessionId, command]);
}

export function inputApprovalId(sessionId: string, request: unknown): string {
  return hashId([sessionId, "security-screen", JSON.stringify(request ?? null)]);
}
