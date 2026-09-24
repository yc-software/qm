import {
  buildMemoryContextSnapshot,
  memoryContextPayload,
  type MemoryContextSnapshot,
} from "../../memory/context-boundary.ts";
import { disclosedMemory } from "../../memory/disclosure.ts";
import type { MemoryService } from "../../memory/memory-service.ts";
import { parseScopeId, personalScope, type Principal } from "../../types.ts";
import { livePersonCapability } from "../artifact-share.ts";
import type { ApiCtx } from "./route.ts";
import { orgScope } from "./shared.ts";

export function memoryForRequest(ctx: ApiCtx, sourcePrincipal?: string, trackReads = true): MemoryService | undefined {
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
    ...(trackReads && ctx.capability?.sessionId
      ? {
          noteRead: async () => {
            if (!ctx.deps.sessions) throw new Error("Memory read tracking unavailable");
            await ctx.deps.sessions.noteMemoryRead(ctx.capability!.sessionId!);
          },
        }
      : {}),
    isCurrentSharedScopeMember: (person, scope) => ctx.app.isCurrentSharedScopeMember(person, scope),
    currentScopeMembers: (scope) => ctx.app.currentScopeMembers(scope),
  });
}

async function memorySnapshotForRequest(ctx: ApiCtx): Promise<MemoryContextSnapshot | null> {
  const { capability, deps, app } = ctx;
  const memory = memoryForRequest(ctx, undefined, false);
  if (!capability || !memory || !deps.config) return null;
  const actor = deps.identity?.classify(capability.actorId) ?? { id: capability.actorId, type: "internal" as const };
  const audience =
    capability.scopeId === personalScope(actor.id) ? [actor] : await app.currentScopeMembers(capability.scopeId);
  if (!audience?.length) return null;
  const posture = await deps.config.resolveSharingPostureDurable(personalScope(actor.id), capability.scopeId);
  const heads = await Promise.all(
    [...new Set(capability.memory?.read ?? [])].map(async (scope) => ({
      scope,
      head: (await memory.readHead?.(scope)) ?? { content: await memory.read(scope), revision: "" },
    })),
  );
  return buildMemoryContextSnapshot({ actorId: actor.id, audience, posture, heads });
}

export async function memoryBoundaryForRequest(ctx: ApiCtx, sessionId: string) {
  try {
    const entries = await ctx.deps.sessions?.getEntries(sessionId);
    const checkpoint = entries?.findLast((entry) => memoryContextPayload(entry));
    const boundary = checkpoint && memoryContextPayload(checkpoint);
    const snapshot = await memorySnapshotForRequest(ctx);
    const allowed = new Set(snapshot?.facts);
    const readEpoch = await ctx.deps.sessions?.memoryReadEpoch(sessionId);
    if (
      !boundary ||
      !snapshot ||
      boundary.snapshot.audience !== snapshot.audience ||
      boundary.snapshot.readEpoch !== readEpoch ||
      !boundary.snapshot.facts.every((fact) => allowed.has(fact))
    )
      return null;
    return { throughSeq: boundary.throughSeq, latestSeq: entries!.at(-1)!.seq };
  } catch {
    return null;
  }
}
