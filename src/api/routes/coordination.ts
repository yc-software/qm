import type { ScopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { deliveryProjection } from "../../coordination/message-board.ts";
import type { CoordinationCaller, CoordinationService, Outcome } from "../../coordination/coordination-service.ts";

const UNAVAILABLE = { error: "not_found", message: "peer coordination isn't enabled here" };

async function callerOf(ctx: ApiCtx): Promise<CoordinationCaller> {
  const { capability, deps } = ctx;
  if (!capability) return { kind: "source" };
  const session = capability.threadRef ? await deps.sessions?.getByThread(capability.threadRef) : null;
  return { kind: "capability", sessionId: session?.id ?? null, actorId: capability.actorId };
}

async function scoped(ctx: ApiCtx, scope: () => Promise<ScopeId | null>): Promise<CoordinationService | null> {
  const service = ctx.deps.coordination;
  const subject = service ? await scope() : null;
  if (!service || !subject || !(await service.availableForScope(subject))) {
    sendJson(ctx.res, 404, UNAVAILABLE);
    return null;
  }
  return service;
}

async function orgWide(ctx: ApiCtx): Promise<CoordinationService | null> {
  const service = ctx.deps.coordination;
  if (!service || !(await service.availableAnywhere())) {
    sendJson(ctx.res, 404, UNAVAILABLE);
    return null;
  }
  return service;
}

function send<T>(ctx: ApiCtx, status: number, outcome: Outcome<T>, render: (value: T) => unknown): void {
  if (!outcome.ok) return sendJson(ctx.res, outcome.status, outcome.body);
  return sendJson(ctx.res, status, render(outcome.value));
}

function senderSubject(ctx: ApiCtx, caller: CoordinationCaller, body: Record<string, unknown>): string | null {
  const claimed = typeof body.senderSessionId === "string" ? body.senderSessionId : null;
  return caller.kind === "capability" ? caller.sessionId : claimed;
}

async function registerPeer(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const service = await scoped(ctx, async () =>
    sessionId ? ((await ctx.deps.sessions?.get(sessionId))?.scopeId ?? null) : null,
  );
  if (!service) return;
  send(ctx, 201, await service.registerPeer(await callerOf(ctx), body), (peer) => ({ peer }));
}

async function listPeers(ctx: ApiCtx): Promise<void> {
  const service = await orgWide(ctx);
  if (!service) return;
  sendJson(ctx.res, 200, { peers: await service.listPeers() });
}

async function getPeer(ctx: ApiCtx): Promise<void> {
  const sessionId = ctx.params.id!;
  const service = await scoped(ctx, () => ctx.deps.coordination!.scopeOfPeer(sessionId));
  if (!service) return;
  send(ctx, 200, await service.getPeer(sessionId), (peer) => ({ peer }));
}

async function putCharacter(ctx: ApiCtx): Promise<void> {
  const sessionId = ctx.params.id!;
  const service = await scoped(ctx, () => ctx.deps.coordination!.scopeOfPeer(sessionId));
  if (!service) return;
  send(ctx, 200, await service.updateCharacter(await callerOf(ctx), sessionId, ctx.body), (peer) => ({ peer }));
}

async function publishMessage(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const caller = await callerOf(ctx);
  const service = await scoped(ctx, async () => {
    const subject = senderSubject(ctx, caller, body);
    return subject ? ctx.deps.coordination!.scopeOfPeer(subject) : null;
  });
  if (!service) return;
  send(ctx, 201, await service.publish(caller, body), (message) => ({ message }));
}

async function previewAudience(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const caller = await callerOf(ctx);
  const service = await scoped(ctx, async () => {
    const subject = senderSubject(ctx, caller, body);
    return subject ? ctx.deps.coordination!.scopeOfPeer(subject) : null;
  });
  if (!service) return;
  send(ctx, 200, await service.previewAudience(caller, body), (value) => value);
}

async function listMessages(ctx: ApiCtx): Promise<void> {
  const service = await orgWide(ctx);
  if (!service) return;
  const after = Number(ctx.url.searchParams.get("after") ?? "");
  const limit = Number(ctx.url.searchParams.get("limit") ?? "");
  sendJson(
    ctx.res,
    200,
    await service.listMessages({
      ...(Number.isInteger(after) && after > 0 ? { afterSeq: after } : {}),
      ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    }),
  );
}

async function getMessage(ctx: ApiCtx): Promise<void> {
  const service = await orgWide(ctx);
  if (!service) return;
  const message = await service.getMessage(ctx.params.id!);
  if (!message) return sendJson(ctx.res, 404, { error: "not_found", message: "no such message" });
  return sendJson(ctx.res, 200, { message });
}

async function getDeliveries(ctx: ApiCtx): Promise<void> {
  const service = await orgWide(ctx);
  if (!service) return;
  const deliveries = await service.deliveriesOf(ctx.params.id!);
  if (!deliveries) return sendJson(ctx.res, 404, { error: "not_found", message: "no such message" });
  return sendJson(ctx.res, 200, { deliveries: deliveries.map(deliveryProjection) });
}

async function createSwarm(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const rootSessionId = typeof body.rootSessionId === "string" ? body.rootSessionId : "";
  const service = await scoped(ctx, async () =>
    rootSessionId ? ctx.deps.coordination!.scopeOfPeer(rootSessionId) : null,
  );
  if (!service) return;
  send(ctx, 201, await service.createSwarm(await callerOf(ctx), body), (swarm) => ({
    swarmId: swarm.id,
    scopeId: swarm.scopeId,
    sessionLimit: swarm.sessionLimit,
    maxChildrenPerParent: swarm.maxChildrenPerParent,
    maxDepth: swarm.maxDepth,
    sessionsUsed: swarm.sessionsUsed,
  }));
}

async function createPool(ctx: ApiCtx): Promise<void> {
  const swarmId = ctx.params.id!;
  const service = await scoped(ctx, () => ctx.deps.coordination!.scopeOfSwarm(swarmId));
  if (!service) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  send(ctx, 201, await service.createPool(await callerOf(ctx), swarmId, body), (value) => value);
}

async function stopSwarm(ctx: ApiCtx): Promise<void> {
  const swarmId = ctx.params.id!;
  const service = await scoped(ctx, () => ctx.deps.coordination!.scopeOfSwarm(swarmId));
  if (!service) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  send(ctx, 200, await service.stop(await callerOf(ctx), swarmId, body), (value) => value);
}

export const coordinationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/peers", auth: "either", handle: registerPeer },
  { method: "GET", path: "/v1/peers", auth: "either", handle: listPeers },
  { method: "GET", path: "/v1/peers/:id", auth: "either", handle: getPeer },
  { method: "PUT", path: "/v1/peers/:id/character", auth: "either", handle: putCharacter },
  { method: "POST", path: "/v1/peer-messages", auth: "either", handle: publishMessage },
  { method: "GET", path: "/v1/peer-messages", auth: "either", handle: listMessages },
  { method: "POST", path: "/v1/peer-messages/audience-preview", auth: "either", handle: previewAudience },
  { method: "GET", path: "/v1/peer-messages/:id", auth: "either", handle: getMessage },
  { method: "GET", path: "/v1/peer-messages/:id/deliveries", auth: "either", handle: getDeliveries },
  { method: "POST", path: "/v1/swarms", auth: "either", handle: createSwarm },
  { method: "POST", path: "/v1/swarms/:id/pool", auth: "either", handle: createPool },
  { method: "POST", path: "/v1/swarms/:id/stop", auth: "either", handle: stopSwarm },
];
