import type { ScopeId, WorkspaceLayer } from "../types.ts";

export type MemoryRecallMode = "off" | "writable" | "visible";
export type MemoryCaptureMode = "off" | "writable";

export interface MemoryPolicy {
  recall: MemoryRecallMode;
  capture: MemoryCaptureMode;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = { recall: "visible", capture: "writable" };

// Tightness ranking per axis: "off" is the most restrictive (nothing
// captured / nothing recalled), "visible" the least. Tighten-only
// composition: a narrower scope may move toward off, never back.
const RECALL_TIGHTNESS: Record<MemoryRecallMode, number> = { off: 0, writable: 1, visible: 2 };

export function composeMemoryPolicy(floor: MemoryPolicy, tighter?: MemoryPolicy): MemoryPolicy {
  /** Compose two memory policies the way the other scope-keyed governance
   * settings compose: *floor* (typically the org value) sets the privacy
   * floor, *tighter* (a narrower scope's stored value) may only restrict
   * further. Capture has two levels (off is tighter than writable); recall
   * composes by tightness rank (#559).
   */
  const scope = tighter ?? floor;
  return {
    capture: floor.capture === "off" || scope.capture === "off" ? "off" : "writable",
    recall:
      RECALL_TIGHTNESS[floor.recall] <= RECALL_TIGHTNESS[scope.recall] ? floor.recall : scope.recall,
  };
}

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
