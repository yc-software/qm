import { createManualProvisioner } from "../../grok-bridge/provisioner.ts";
import { GrokBridgeError } from "../../grok-bridge/types.ts";
import { personalScope } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import { PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import { isObj, orgScope } from "./shared.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";

const provisioner = createManualProvisioner();

function actorIdOf(ctx: ApiCtx, body: Record<string, unknown>): string | undefined {
  if (ctx.capability?.actorId) return ctx.capability.actorId;
  if (ctx.actor?.p) return ctx.actor.p;
  return typeof body.actorId === "string" ? body.actorId : undefined;
}

function actorTypeOf(body: Record<string, unknown>): "internal" | "guest" {
  return body.actorType === "guest" ? "guest" : "internal";
}

async function requireBridge(ctx: ApiCtx | BaseCtx): Promise<boolean> {
  const bridge = ctx.deps.grokBridge;
  const flags = ctx.deps.featureFlags;
  if (!bridge || !flags) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return false;
  }
  const on = await flags.enabled("grok_bridge", orgScope());
  if (!on) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return false;
  }
  return true;
}

function sendBridgeError(ctx: { res: ApiCtx["res"] }, error: unknown): void {
  if (error instanceof GrokBridgeError) {
    sendJson(ctx.res, error.status, { error: error.code, message: error.message });
    return;
  }
  sendJson(ctx.res, 500, { error: "internal", message: errMessage(error) });
}

async function createPairing(ctx: ApiCtx): Promise<void> {
  if (!(await requireBridge(ctx))) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const actorId = actorIdOf(ctx, body);
  if (!actorId || typeof body.agentName !== "string" || typeof body.ownerPrincipalId !== "string") {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "agentName, ownerPrincipalId, and actor are required",
    });
  }
  try {
    const pairing = await ctx.deps.grokBridge!.requestPairing({
      agentName: body.agentName,
      ownerPrincipalId: body.ownerPrincipalId,
      actorId,
      actorType: actorTypeOf(body),
      originScopeId: typeof body.originScopeId === "string" ? body.originScopeId : personalScope(body.ownerPrincipalId),
    });
    sendJson(ctx.res, 200, {
      pairing,
      skill: provisioner.skillFor(pairing),
    });
  } catch (error) {
    sendBridgeError(ctx, error);
  }
}

async function decidePairing(ctx: ApiCtx): Promise<void> {
  if (!(await requireBridge(ctx))) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const actorId = actorIdOf(ctx, body);
  if (!actorId || (body.decision !== "accept" && body.decision !== "decline")) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "decision must be accept or decline" });
  }
  try {
    sendJson(ctx.res, 200, {
      pairing: await ctx.deps.grokBridge!.decidePairing(ctx.params.id!, actorId, body.decision),
    });
  } catch (error) {
    sendBridgeError(ctx, error);
  }
}

async function completeInbound(ctx: ApiCtx): Promise<void> {
  if (!(await requireBridge(ctx))) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const actorId = actorIdOf(ctx, body);
  if (!actorId || typeof body.webhookUrl !== "string" || typeof body.webhookKey !== "string") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "webhookUrl and webhookKey are required" });
  }
  try {
    sendJson(ctx.res, 200, {
      pairing: await ctx.deps.grokBridge!.completeInbound(ctx.params.id!, actorId, {
        webhookUrl: body.webhookUrl,
        webhookKey: body.webhookKey,
        ...(typeof body.grokBotId === "string" ? { grokBotId: body.grokBotId } : {}),
      }),
    });
  } catch (error) {
    sendBridgeError(ctx, error);
  }
}

async function revokePairing(ctx: ApiCtx): Promise<void> {
  if (!(await requireBridge(ctx))) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const actorId = actorIdOf(ctx, body);
  if (!actorId) return sendJson(ctx.res, 400, { error: "bad_request", message: "actor is required" });
  try {
    await ctx.deps.grokBridge!.revoke(ctx.params.id!, actorId);
    sendJson(ctx.res, 200, { ok: true });
  } catch (error) {
    sendBridgeError(ctx, error);
  }
}

async function createJob(ctx: ApiCtx): Promise<void> {
  if (!(await requireBridge(ctx))) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const actorId = actorIdOf(ctx, body);
  if (
    !actorId ||
    typeof body.agentName !== "string" ||
    typeof body.ownerPrincipalId !== "string" ||
    typeof body.originSessionId !== "string" ||
    typeof body.instruction !== "string"
  ) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "agentName, ownerPrincipalId, originSessionId, instruction, and actor are required",
    });
  }
  const publicBase = ctx.deps.publicUrl ?? ctx.deps.portalUrl ?? "";
  try {
    sendJson(ctx.res, 200, {
      job: await ctx.deps.grokBridge!.dispatch({
        agentName: body.agentName,
        ownerPrincipalId: body.ownerPrincipalId,
        originSessionId: body.originSessionId,
        originActorId: actorId,
        actorType: actorTypeOf(body),
        instruction: body.instruction,
        callbackBaseUrl: publicBase || "http://127.0.0.1",
      }),
    });
  } catch (error) {
    sendBridgeError(ctx, error);
  }
}

async function getJob(ctx: ApiCtx): Promise<void> {
  if (!(await requireBridge(ctx))) return;
  const viewer = actorIdOf(ctx, isObj(ctx.body) ? ctx.body : {}) ?? ctx.url.searchParams.get("viewer") ?? undefined;
  if (!viewer) return sendJson(ctx.res, 400, { error: "bad_request", message: "viewer is required" });
  try {
    sendJson(ctx.res, 200, { job: await ctx.deps.grokBridge!.getJob(ctx.params.id!, viewer) });
  } catch (error) {
    sendBridgeError(ctx, error);
  }
}

async function ingestEvent(ctx: BaseCtx): Promise<void> {
  const { req, res, deps, params } = ctx;
  if (!(await requireBridge(ctx))) return;
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return sendJson(res, 413, { error: "payload_too_large", message: errMessage(error) });
    }
    return sendJson(res, 400, { error: "bad_request" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return sendJson(res, 400, { error: "bad_request", message: "invalid JSON" });
  }
  const header = req.headers.authorization;
  const authorization = Array.isArray(header) ? header[0] : header;
  try {
    const result = await deps.grokBridge!.ingest(params.id!, parsed, authorization);
    sendJson(res, result.duplicate ? 200 : 202, { ok: true, duplicate: result.duplicate });
  } catch (error) {
    sendBridgeError(ctx, error);
  }
}

export const grokBridgeRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/grok-bridge/jobs/:id/events", auth: "public", handle: ingestEvent },
];

export const grokBridgeRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/grok-bridge/pairings", auth: "either", handle: createPairing },
  { method: "POST", path: "/v1/grok-bridge/pairings/:id/decide", auth: "either", handle: decidePairing },
  { method: "POST", path: "/v1/grok-bridge/pairings/:id/inbound", auth: "either", handle: completeInbound },
  { method: "POST", path: "/v1/grok-bridge/pairings/:id/revoke", auth: "either", handle: revokePairing },
  { method: "POST", path: "/v1/grok-bridge/jobs", auth: "either", handle: createJob },
  { method: "GET", path: "/v1/grok-bridge/jobs/:id", auth: "either", handle: getJob },
];
