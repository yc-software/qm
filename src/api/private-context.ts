import {
  refreshPrivateContext,
  inheritContextSources,
  type ContextSource,
  type PrivateContext,
} from "../sessions/private-context.ts";
import type { ApiCtx } from "./routes/route.ts";

export function requestPrivateContext(ctx: ApiCtx, actorId: string): PrivateContext {
  const capability = ctx.capability;
  return capability
    ? {
        actorId: capability.actorId,
        computer: capability.computer,
        privateRead: capability.privateRead,
        scopeId: capability.scopeId,
        audienceScopeId: capability.audienceScopeId,
        sessionId: capability.sessionId,
        personalOnly: capability.personalOnly,
        botActor: capability.botActor,
        sourceProvenance: ctx.sourceProvenance,
      }
    : { actorId };
}

export async function inheritRequestSources(
  ctx: ApiCtx,
  sources: readonly ContextSource[],
  actorId: string,
): Promise<Set<string>> {
  const capability = ctx.capability;
  const context = requestPrivateContext(ctx, actorId);
  const blocked = await inheritContextSources(ctx.app, context, sources);
  if (context.personalOnly && capability) capability.personalOnly = true;
  ctx.sourceProvenance = context.sourceProvenance;
  return blocked;
}

export function requestSandboxResources(ctx: ApiCtx, actorId: string) {
  const resources = ctx.deps.sandboxResources;
  if (!resources || !ctx.capability) return resources;
  const context = requestPrivateContext(ctx, actorId);
  return resources.forTurn({
    actorId: context.actorId,
    scopeId: ctx.capability.scopeId,
    isCurrent: () => ctx.app.authorizesCapabilityScope(ctx.capability!),
    privacy: {
      current: () =>
        refreshPrivateContext(
          {
            get: (id) => ctx.app.getSessionContext(id),
            recordContextProvenance: (id, scope, source) => ctx.app.recordContextProvenance(id, scope, source),
          },
          context,
        ),
      sessions: ctx.app,
    },
  });
}
