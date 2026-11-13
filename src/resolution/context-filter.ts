import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";

export function entitledScopes(p: Principal, sessionScopeId: ScopeId, orgScopeId: ScopeId): ScopeId[] {
  return [orgScopeId, sessionScopeId, scopeId("personal", p.id), ...(p.teamIds ?? []).map((t) => scopeId("team", t))];
}

export function loadsScopeContext(actorId: string, scope: ScopeId, botActor: boolean): boolean {
  const { kind, ref } = parseScopeId(scope);
  return !botActor || kind !== "personal" || !samePerson(ref, actorId);
}

export function principalEntitledToScope(
  p: Principal,
  label: ScopeId,
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
): boolean {
  return entitledScopes(p, sessionScopeId, orgScopeId).includes(label);
}
