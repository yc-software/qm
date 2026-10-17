import { z } from "zod";
import { parseScopeId, scopeId } from "../../types.ts";
import { sendJson, readRawBody, PayloadTooLargeError } from "../http.ts";
import { loadAdministrable } from "./loops.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";
import { conversationEvent, type LoopIngress, type IngressSetup } from "../../loops/ingress.ts";
import { errMessage } from "../../util/errors.ts";

const eventsSchema = z.object({
  events: z
    .array(
      z.object({
        sourceKey: z.string().min(1),
        author: z.enum(["owner", "other"]),
        at: z.number().finite().positive(),
        text: z.string().optional(),
        from: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
});

function view(source: Omit<LoopIngress, "secret">, publicUrl?: string) {
  const { secret: _secret, ...safe } = source as LoopIngress;
  const path = `/v1/loop-ingress/${source.kind === "gmail" ? "gmail" : source.id}`;
  return { ...safe, url: publicUrl ? new URL(path, publicUrl).href : path };
}

async function list(ctx: ApiCtx) {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  if (!(await ctx.deps.featureFlags?.enabled("inbox_loops", scopeId("personal", loaded.acting.actorId))))
    return sendJson(ctx.res, 403, { error: "feature_disabled" });
  const ingress = ctx.deps.loopIngress;
  if (!ingress) return sendJson(ctx.res, 404, { error: "unavailable" });
  return sendJson(ctx.res, 200, {
    sources: (await ingress.list(loaded.loop.id)).map((source) => view(source, ctx.deps.publicUrl)),
    gmailAvailable: ingress.gmailAvailable,
  });
}

async function change(ctx: ApiCtx) {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  if (!(await ctx.deps.featureFlags?.enabled("inbox_loops", scopeId("personal", loaded.acting.actorId))))
    return sendJson(ctx.res, 403, { error: "feature_disabled" });
  const ingress = ctx.deps.loopIngress;
  if (!ingress) return sendJson(ctx.res, 404, { error: "unavailable" });
  if (!loaded.acting.liveHuman)
    return sendJson(ctx.res, 403, {
      error: "human_required",
      message: "Configuring event ingestion requires a live human actor",
    });
  if (loaded.loop.state === "archived") return sendJson(ctx.res, 409, { error: "archived" });
  if (!isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request" });
  try {
    if (ctx.params.sourceId) {
      if (typeof ctx.body.enabled !== "boolean") return sendJson(ctx.res, 400, { error: "bad_request" });
      await ingress.setEnabled(loaded.loop.id, ctx.params.sourceId, ctx.body.enabled);
      return sendJson(ctx.res, 200, { ok: true });
    }
    if (
      !["webhook", "slack", "gmail"].includes(String(ctx.body.kind)) ||
      (ctx.body.secret !== undefined && typeof ctx.body.secret !== "string") ||
      (ctx.body.teamId !== undefined && typeof ctx.body.teamId !== "string") ||
      (ctx.body.channels !== undefined &&
        (!Array.isArray(ctx.body.channels) ||
          ctx.body.channels.length > 100 ||
          ctx.body.channels.some((channel) => typeof channel !== "string")))
    )
      return sendJson(ctx.res, 400, { error: "bad_request", message: "Invalid ingestion settings" });
    const source = await ingress.create(loaded.loop, ctx.body as unknown as IngressSetup);
    return sendJson(ctx.res, 201, {
      source: view(source, ctx.deps.publicUrl),
      ...(source.kind === "webhook" ? { secret: source.secret } : {}),
    });
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "setup_failed", message: errMessage(error) });
  }
}

async function events(ctx: ApiCtx) {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const ingress = ctx.deps.loopIngress;
  if (!ingress) return sendJson(ctx.res, 404, { error: "unavailable" });
  if (loaded.loop.state === "archived") return sendJson(ctx.res, 409, { error: "archived" });
  if (
    ctx.capability &&
    parseScopeId(loaded.loop.ownerScopeId).kind === "personal" &&
    ctx.capability.privateScope !== true
  )
    return sendJson(ctx.res, 403, {
      error: "forbidden",
      message: "personal loop events come only from its owner's scope",
    });
  const parsed = eventsSchema.safeParse(ctx.body);
  if (!parsed.success)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: 'body needs {events: 1-20 of {sourceKey, author: "owner"|"other", at (ms), text?, from?}}',
    });
  const entries = parsed.data.events.map((event) =>
    conversationEvent({ loopId: loaded.loop.id, sourceKey: event.sourceKey }, event),
  );
  const queued = await ingress.enqueueConversation(loaded.loop, entries);
  return sendJson(
    ctx.res,
    queued ? 202 : 409,
    queued ? { ok: true, queued: entries.length } : { error: "not_accepting" },
  );
}

async function receive(ctx: BaseCtx) {
  if (!ctx.deps.loopIngress) {
    ctx.req.resume();
    return sendJson(ctx.res, 404, { error: "not_found" });
  }
  try {
    const rawBody = await readRawBody(ctx.req);
    const result = await ctx.deps.loopIngress.receive(ctx.params.id!, { headers: ctx.req.headers, rawBody });
    ctx.res.writeHead(result.status, { "content-type": "text/plain", "cache-control": "no-store" });
    ctx.res.end(result.body);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return sendJson(ctx.res, 413, { error: "payload_too_large" });
    throw error;
  }
}

export const loopIngressRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/loops/:id/ingestion", auth: "source", handle: list },
  { method: "POST", path: "/v1/loops/:id/ingestion", auth: "source", handle: change },
  { method: "PATCH", path: "/v1/loops/:id/ingestion/:sourceId", auth: "source", handle: change },
  { method: "POST", path: "/v1/loops/:id/events", auth: "either", handle: events },
];

export const loopIngressRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/loop-ingress/:id", auth: "public", handle: receive },
];
