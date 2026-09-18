import { randomUUID } from "node:crypto";
import { hashId } from "../util/crypto.ts";

export function commandApprovalId(sessionId: string, command: string, revision?: string): string {
  return hashId(revision === undefined ? [sessionId, command] : [sessionId, command, revision, randomUUID()]);
}

export function inputApprovalId(sessionId: string, request: unknown): string {
  return hashId([sessionId, "security-screen", JSON.stringify(request ?? null)]);
}
