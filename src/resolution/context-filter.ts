import type { Principal, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";

export function entitledScopes(p: Principal, sessionScopeId: ScopeId, orgScopeId: ScopeId): ScopeId[] {
  return [orgScopeId, sessionScopeId, scopeId("personal", p.id), ...(p.teamIds ?? []).map((t) => scopeId("team", t))];
}

export function principalEntitledToScope(
  p: Principal,
  label: ScopeId,
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
): boolean {
  return entitledScopes(p, sessionScopeId, orgScopeId).includes(label);
}
