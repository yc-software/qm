import type { Principal, ScopeId, SessionEntry } from "../types.ts";
import { parseScopeId } from "../types.ts";

export function principalEntitledToScope(
  p: Principal,
  label: ScopeId,
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
): boolean {
  if (label === orgScopeId) return true;
  if (label === sessionScopeId) return true;
  const { kind, ref } = parseScopeId(label);
  if (kind === "personal") return p.id === ref;
  if (kind === "team") return (p.teamIds ?? []).includes(ref);
  return false;
}

export function filterHistoryForAudience(
  entries: SessionEntry[],
  audience: Principal[],
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
): SessionEntry[] {
  if (audience.length === 0) return [];
  return entries.filter((e) =>
    audience.every((p) => principalEntitledToScope(p, e.scopeLabel, sessionScopeId, orgScopeId)),
  );
}
