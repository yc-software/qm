import type { EntryType, ScopeId } from "../types.ts";

export interface ClassifyInput {
  type: EntryType;
  sessionScopeId: ScopeId;
  orgScopeId: ScopeId;
  sourceScopeId?: ScopeId | null;
}

export function classifyScopeLabel(input: ClassifyInput): ScopeId {
  if (input.type === "soul") return input.orgScopeId;
  if (input.type === "tool_result" && input.sourceScopeId) return input.sourceScopeId;
  return input.sessionScopeId;
}
