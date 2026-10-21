import { hashId } from "../util/crypto.ts";

export function commandApprovalId(sessionId: string, command: string): string {
  return hashId([sessionId, command]);
}

export function inputApprovalId(sessionId: string, request: unknown): string {
  return hashId([sessionId, "security-screen", JSON.stringify(request ?? null)]);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

export function toolCallApprovalKey(tool: string, params: unknown): string {
  return `tool-call:${hashId([tool, JSON.stringify(canonical(params ?? null))], 64)}`;
}
