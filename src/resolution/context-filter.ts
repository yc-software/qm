import type { Principal, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import { attestableAudience } from "../directory/person.ts";

export function loadsScopeContext(actorId: string, scope: ScopeId, ownScopeBotWork: boolean): boolean {
  return !ownScopeBotWork || !attestableAudience(actorId, scope);
}

export function isOwnScopeBotWork(
  work: { actorId: string; scopeId: ScopeId; botActor?: boolean } | null | undefined,
): boolean {
  return !!work && !loadsScopeContext(work.actorId, work.scopeId, work.botActor === true);
}

export function entitledScopes(ownScopeBotWork: boolean) {
  return (p: Principal, sessionScopeId: ScopeId, orgScopeId: ScopeId): ScopeId[] =>
    [orgScopeId, sessionScopeId, scopeId("personal", p.id), ...(p.teamIds ?? []).map((t) => scopeId("team", t))].filter(
      (scope) => loadsScopeContext(p.id, scope, ownScopeBotWork),
    );
}

export function principalEntitledToScope(
  p: Principal,
  label: ScopeId,
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
  ownScopeBotWork: boolean,
): boolean {
  return entitledScopes(ownScopeBotWork)(p, sessionScopeId, orgScopeId).includes(label);
}
