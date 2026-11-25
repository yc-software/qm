import type { ScopeId } from "../types.ts";

export type MemoryRecallMode = "off" | "writable" | "visible";
export type MemoryCaptureMode = "off" | "writable";
export type MemoryCardMode = "off" | "on";

export interface MemoryPolicy {
  recall: MemoryRecallMode;
  capture: MemoryCaptureMode;
  card: MemoryCardMode;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = { recall: "visible", capture: "writable", card: "on" };

export function parseMemoryRecallMode(value: string | undefined): MemoryRecallMode {
  return value === "off" || value === "writable" || value === "visible" ? value : DEFAULT_MEMORY_POLICY.recall;
}

export function parseMemoryCaptureMode(value: string | undefined): MemoryCaptureMode {
  return value === "off" ? "off" : DEFAULT_MEMORY_POLICY.capture;
}

export function parseMemoryCardMode(value: string | undefined): MemoryCardMode {
  return value === "off" ? "off" : DEFAULT_MEMORY_POLICY.card;
}

export function recallMemoryScopes(
  policy: MemoryPolicy,
  writableScopeId: ScopeId,
  readOnlyScopeIds: ScopeId[],
): ScopeId[] {
  if (policy.recall === "off") return [];
  if (policy.recall === "writable") return [writableScopeId];

  return [...new Set([writableScopeId, ...readOnlyScopeIds])];
}
