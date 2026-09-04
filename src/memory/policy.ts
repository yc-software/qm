import type { ScopeId, WorkspaceLayer } from "../types.ts";

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

export function writableMemoryScope(layers: WorkspaceLayer[], fallback: ScopeId): ScopeId {
  return layers.find((l) => l.mode === "rw")?.scopeId ?? fallback;
}

export function recallMemoryScopes(
  policy: MemoryPolicy,
  layers: WorkspaceLayer[],
  writableScopeId: ScopeId,
): ScopeId[] {
  if (policy.recall === "off") return [];
  if (policy.recall === "writable") return [writableScopeId];

  const scopes = [writableScopeId, ...layers.map((l) => l.scopeId)];
  return [...new Set(scopes)];
}
