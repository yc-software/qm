import { CoordinationError, publicPeer } from "../../coordination/types.ts";
import { ownPeerSession, peerActor, peerRoute, peerRunFence } from "./peers.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

function spawning(ctx: ApiCtx) {
  if (!ctx.deps.peerSpawning) throw new CoordinationError(404, "coordination_disabled", "coordination is disabled");
  return ctx.deps.peerSpawning;
}

export const peerSpawnRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/peer-spawns",
    auth: "either",
    handle: peerRoute(async (ctx) => {
      const parentId = await ownPeerSession(ctx);
      const body = isObj(ctx.body) ? ctx.body : {};
      if (typeof body.task !== "string" || typeof body.name !== "string" || typeof body.idempotencyKey !== "string")
        throw new CoordinationError(400, "bad_request", "provide task, name and idempotencyKey");
      const backend = ctx.deps.peerSpawnBackend;
      if (!backend)
        throw new CoordinationError(
          503,
          "spawn_backend_unavailable",
          "spawning requires enabled sandbox-resource management",
        );
      await ctx.deps.peerIdentity!.ensure({ id: parentId, scopeId: ctx.capability!.scopeId });
      const operation = await spawning(ctx).reserve(
        {
          parentId,
          parentRunId: ctx.capability!.runId!,
          backend,
          task: body.task,
          name: body.name,
          character: body.character,
          idempotencyKey: body.idempotencyKey,
        },
        peerRunFence(ctx, parentId),
      );
      return {
        spawn: {
          id: operation.id,
          parentId: operation.parentId,
          childId: operation.childId,
          state: operation.state,
          createdAt: operation.createdAt,
        },
      };
    }),
  },
  {
    method: "GET",
    path: "/v1/peers/:id/subtree",
    auth: "either",
    handle: peerRoute(
      async (ctx) => {
        const inspector = ctx.deps.peerInspection?.spawning ?? spawning(ctx);
        const result = await inspector.inspect(ctx.params.id!);
        const actor = await peerActor(ctx);
        return {
          peer: publicPeer(result.peer),
          count: result.count,
          cap: result.cap,
          manageable:
            !!ctx.deps.peerLifecycle && !ctx.capability && (await ctx.app.managesScope(actor, result.peer.scopeId)),
          nodes: await Promise.all(
            (await inspector.tree(ctx.params.id!)).map(async (node) => ({
              ...node,
              ...((await ctx.app.getSessionForViewer(node.peer.id, actor)) ? { sessionId: node.peer.id } : {}),
            })),
          ),
        };
      },
      { inspection: true },
    ),
  },
  {
    method: "POST",
    path: "/v1/peers/:id/lifecycle",
    auth: "source",
    handle: peerRoute(async (ctx) => {
      if (ctx.capability) throw new CoordinationError(403, "human_control_required", "use the human session controls");
      if (!ctx.deps.peerLifecycle)
        throw new CoordinationError(404, "coordination_disabled", "coordination is disabled");
      const { peer } = await spawning(ctx).inspect(ctx.params.id!);
      if (!(await ctx.app.managesScope(await peerActor(ctx), peer.scopeId)))
        throw new CoordinationError(403, "forbidden", "session management permission required");
      const body = isObj(ctx.body) ? ctx.body : {};
      if (
        (body.action !== "pause" && body.action !== "resume" && body.action !== "stop") ||
        (body.subtree !== undefined && typeof body.subtree !== "boolean")
      )
        throw new CoordinationError(
          400,
          "bad_request",
          "provide action pause, resume or stop and an optional subtree boolean",
        );
      return { changed: await ctx.deps.peerLifecycle.transition(peer.id, body.action, body.subtree === true) };
    }),
  },
  {
    method: "PUT",
    path: "/v1/peers/:id/subtree-limit",
    auth: "either",
    handle: peerRoute(async (ctx) => {
      const id = await ownPeerSession(ctx);
      if (id !== ctx.params.id) throw new CoordinationError(403, "forbidden", "agents may lower only their own limit");
      if (!isObj(ctx.body) || typeof ctx.body.limit !== "number")
        throw new CoordinationError(400, "bad_request", "provide a numeric limit");
      return spawning(ctx).lowerLimit(id, ctx.body.limit, peerRunFence(ctx, id));
    }),
  },
];
