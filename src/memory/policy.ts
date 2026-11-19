import type { ScopeId } from "../types.ts";

export interface MemoryAccess {
  write?: ScopeId;
  teamWrite?: ScopeId;
  orgWrite?: ScopeId;
  read: ScopeId[];
  notebookOnly?: true;
  personalOnly?: true;
}

export function writableNotebook(access: MemoryAccess | undefined, requested?: string): ScopeId | undefined {
  const scope = requested === "team" ? access?.teamWrite : (requested ?? access?.write);
  return scope && (scope === access?.write || scope === access?.teamWrite) ? scope : undefined;
}

export type MemoryRecallMode = "off" | "writable" | "visible";
export type MemoryCaptureMode = "off" | "writable";

export interface MemoryPolicy {
  recall: MemoryRecallMode;
  capture: MemoryCaptureMode;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = { recall: "visible", capture: "writable" };

export function parseMemoryRecallMode(value: string | undefined): MemoryRecallMode {
  return value === "off" || value === "writable" || value === "visible" ? value : DEFAULT_MEMORY_POLICY.recall;
}

export function parseMemoryCaptureMode(value: string | undefined): MemoryCaptureMode {
  return value === "off" ? "off" : DEFAULT_MEMORY_POLICY.capture;
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
