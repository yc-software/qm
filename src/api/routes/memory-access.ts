import { mergeProvenance } from "../../memory/facts.ts";
import { samePerson } from "../../directory/person.ts";
import { disclosedMemory } from "../../memory/disclosure.ts";
import type { MemoryService } from "../../memory/memory-service.ts";
import { parseScopeId, personalScope, type Principal } from "../../types.ts";
import { livePersonCapability } from "../artifact-share.ts";
import type { ApiCtx } from "./route.ts";

export function memoryForRequest(ctx: ApiCtx, sourcePrincipal?: string): MemoryService | undefined {
  if (!ctx.deps.memory) return undefined;
  const id = ctx.capability?.actorId ?? ctx.actor?.p ?? sourcePrincipal;
  if (!id) return undefined;
  const actor: Principal = ctx.deps.identity?.classify(id) ?? { id, type: "internal" };
  const targetScope = ctx.capability?.scopeId ?? personalScope(id);
  const claimed = ctx.capability
    ? [
        ...(ctx.capability.memory?.read ?? []),
        ctx.capability.memory?.write,
        ctx.capability.memory?.teamWrite,
        ctx.capability.memory?.orgWrite,
      ].filter((scope): scope is string => !!scope)
    : [personalScope(id)];
  const nativeScopes = claimed;
  const target = parseScopeId(targetScope);
  const personal = target.kind === "personal" && samePerson(target.ref, id);
  return disclosedMemory(ctx.deps.memory, {
    actor,
    computer: ctx.capability?.computer,
    privateRead: ctx.capability?.privateRead,
    targetScope,
    ...(ctx.capability?.audienceScopeId ? { audienceScopeId: ctx.capability.audienceScopeId } : {}),
    nativeScopes,
    audience: personal ? [actor] : (ctx.capability?.members ?? []),
    open: !ctx.capability || livePersonCapability(ctx.capability),
    ...(ctx.capability?.memory?.notebookOnly ? { notebookOnly: true } : {}),
    config: ctx.deps.config,
    isCurrentSharedScopeMember: (person, scope) => ctx.app.isCurrentSharedScopeMember(person, scope),
    currentScopeMembers: (scope) => ctx.app.currentScopeMembers(scope),
    onDisclosure: async (facts) => {
      const capability = ctx.capability;
      if (!capability) return true;
      const provenance = mergeProvenance(facts, "ordinary");
      if (!capability.sessionId) return !provenance.personalOnly;
      ctx.sourceProvenance = await ctx.app.recordContextProvenance(
        capability.sessionId,
        capability.scopeId,
        provenance,
      );
      if (provenance.personalOnly) capability.personalOnly = true;
      return true;
    },
  });
}
