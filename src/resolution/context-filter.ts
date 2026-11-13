import type { Principal, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import { attestableAudience } from "../directory/person.ts";

export function loadsScopeContext(actorId: string, scope: ScopeId, botActor: boolean): boolean {
  return !botActor || !attestableAudience(actorId, scope);
}

export function entitledScopes(botActor: boolean) {
  return (p: Principal, sessionScopeId: ScopeId, orgScopeId: ScopeId): ScopeId[] =>
    [orgScopeId, sessionScopeId, scopeId("personal", p.id), ...(p.teamIds ?? []).map((t) => scopeId("team", t))].filter(
      (scope) => loadsScopeContext(p.id, scope, botActor),
    );
}

export function principalEntitledToScope(
  p: Principal,
  label: ScopeId,
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
  botActor: boolean,
): boolean {
  return entitledScopes(botActor)(p, sessionScopeId, orgScopeId).includes(label);
}
