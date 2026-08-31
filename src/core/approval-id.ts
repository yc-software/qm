import { hashId } from "../util/crypto.ts";

export function commandApprovalId(sessionId: string, command: string, occurrence?: string): string {
  return hashId([sessionId, command, ...(occurrence ? [occurrence] : [])]);
}

export function inputApprovalId(sessionId: string, request: unknown): string {
  return hashId([sessionId, "security-screen", JSON.stringify(request ?? null)]);
}
