import { inheritContextSources, type ContextSource, type PrivateContext } from "../sessions/private-context.ts";
import type { ApiCtx } from "./routes/route.ts";

export async function inheritRequestSources(
  ctx: ApiCtx,
  sources: readonly ContextSource[],
  actorId: string,
): Promise<Set<string>> {
  const capability = ctx.capability;
  const context: PrivateContext = capability
    ? {
        actorId: capability.actorId,
        scopeId: capability.scopeId,
        audienceScopeId: capability.audienceScopeId,
        sessionId: capability.sessionId,
        personalOnly: capability.personalOnly,
        botActor: capability.botActor,
        sourceProvenance: ctx.sourceProvenance,
      }
    : { actorId };
  const blocked = await inheritContextSources(ctx.app, context, sources);
  if (context.personalOnly && capability) capability.personalOnly = true;
  ctx.sourceProvenance = context.sourceProvenance;
  return blocked;
}
