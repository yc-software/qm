import { sendJson } from "../http.ts";
import { audit, isObj, orgScope } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import type { IngestEvent } from "../../surface-cache/surface-cache.ts";

function strMap(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === "string") out[k] = v;
  return out;
}

export function toEvent(raw: unknown): IngestEvent | null {
  if (!isObj(raw)) return null;
  if (typeof raw.container !== "string" || !raw.container) return null;
  if (typeof raw.ts !== "string" || !raw.ts) return null;
  const files = Array.isArray(raw.files)
    ? raw.files
        .filter((f): f is Record<string, unknown> => isObj(f) && typeof f.fileId === "string")
        .map((f) => ({
          fileId: f.fileId as string,
          ...(typeof f.name === "string" ? { name: f.name } : {}),
          ...(typeof f.mimetype === "string" ? { mimetype: f.mimetype } : {}),
        }))
    : undefined;
  const members = Array.isArray(raw.members)
    ? raw.members.filter((m): m is string => typeof m === "string")
    : undefined;
  return {
    container: raw.container,
    ts: raw.ts,
    ...(typeof raw.sub === "string" && raw.sub ? { sub: raw.sub } : {}),
    ...(typeof raw.authorId === "string" ? { authorId: raw.authorId } : {}),
    ...(typeof raw.authorName === "string" ? { authorName: raw.authorName } : {}),
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
    ...(isObj(raw.mentions) ? { mentions: strMap(raw.mentions) } : {}),
    ...(raw.self === true ? { self: true } : {}),
    ...(raw.bot === true ? { bot: true } : {}),
    ...(raw.mentionsSelf === true ? { mentionsSelf: true } : {}),
    ...(typeof raw.editedAt === "number" ? { editedAt: raw.editedAt } : {}),
    ...(raw.deleted === true ? { deleted: true } : {}),
    ...(raw.handled === true ? { handled: true } : {}),
    ...(typeof raw.createdAt === "number" ? { createdAt: raw.createdAt } : {}),
    ...(files ? { files } : {}),
    ...(members ? { members } : {}),
    ...(typeof raw.containerName === "string" ? { containerName: raw.containerName } : {}),
    ...(raw.kind === "channel" || raw.kind === "dm" || raw.kind === "group" ? { kind: raw.kind } : {}),
  };
}

async function ingestSurfaceEvents(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body } = ctx;
  const b = isObj(body) ? body : {};
  const surface = typeof b.surface === "string" && b.surface ? b.surface : "slack";
  const events = Array.isArray(b.events) ? b.events.map(toEvent).filter((e): e is IngestEvent => e !== null) : [];
  if (!events.length) return sendJson(res, 400, { error: "bad_request", message: "events[] required" });
  const sb = isObj(b.self) ? b.self : {};
  const self =
    typeof sb.name === "string" || typeof sb.mentionId === "string"
      ? {
          ...(typeof sb.name === "string" ? { name: sb.name } : {}),
          ...(typeof sb.mentionId === "string" ? { mentionId: sb.mentionId } : {}),
        }
      : undefined;
  const { upserted } = await app.ingestSurfaceEvents(events, surface, self);
  audit(deps, {
    principalId: `surface:${surface}`,
    action: "surface.ingest",
    resource: "surface_cache",
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, { ok: true, upserted });
}

async function getChannelPolicy(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const container = url.searchParams.get("container");
  if (!container) return sendJson(res, 400, { error: "bad_request", message: "container required" });
  const policy = await app.getChannelPolicy(container);
  return sendJson(res, 200, { policy });
}

async function setChannelPolicy(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body } = ctx;
  const b = isObj(body) ? body : {};
  if (typeof b.container !== "string" || !b.container)
    return sendJson(res, 400, { error: "bad_request", message: "container required" });
  if (typeof b.orders !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "orders (string) required" });
  const setBy = typeof b.setBy === "string" ? b.setBy : undefined;
  const policy = await app.setChannelPolicy(b.container, b.orders, setBy);
  if (!policy) return sendJson(res, 404, { error: "not_found", message: "surface cache not enabled" });
  audit(deps, {
    principalId: setBy ?? "system",
    action: "surface.policy.set",
    resource: b.container,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, { policy });
}

export const surfaceCacheRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/surface-cache/ingest", auth: "source", handle: ingestSurfaceEvents },
  { method: "GET", path: "/v1/surface-cache/policy", auth: "source", handle: getChannelPolicy },
  { method: "POST", path: "/v1/surface-cache/policy", auth: "source", handle: setChannelPolicy },
];
