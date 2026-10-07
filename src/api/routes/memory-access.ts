import { disclosedMemory } from "../../memory/disclosure.ts";
import type { MemoryService } from "../../memory/memory-service.ts";
import { parseScopeId, personalScope, type Principal } from "../../types.ts";
import { livePersonCapability } from "../artifact-share.ts";
import type { ApiCtx } from "./route.ts";
import { orgScope } from "./shared.ts";

export function memoryForRequest(ctx: ApiCtx, sourcePrincipal?: string): MemoryService | undefined {
  if (!ctx.deps.memory) return undefined;
  const id = ctx.capability?.actorId ?? ctx.actor?.p ?? sourcePrincipal;
  if (!id) return undefined;
  const actor: Principal = ctx.deps.identity?.classify(id) ?? { id, type: "internal" };
  const targetScope = ctx.capability?.scopeId ?? personalScope(id);
  const claimed = ctx.capability
    ? [...(ctx.capability.memory?.read ?? []), ctx.capability.memory?.write, ctx.capability.memory?.orgWrite].filter(
        (scope): scope is string => !!scope,
      )
    : [personalScope(id)];
  const nativeScopes = claimed.filter(
    (scope) => scope === targetScope || scope === orgScope(ctx.deps) || parseScopeId(scope).kind === "team",
  );
  return disclosedMemory(ctx.deps.memory, {
    actor,
    targetScope,
    nativeScopes,
    audience: targetScope === personalScope(id) ? [actor] : (ctx.capability?.members ?? []),
    open: !ctx.capability || livePersonCapability(ctx.capability),
    config: ctx.deps.config,
    isCurrentSharedScopeMember: (person, scope) => ctx.app.isCurrentSharedScopeMember(person, scope),
    currentScopeMembers: (scope) => ctx.app.currentScopeMembers(scope),
  });
}
