import { refuseImpersonated, sendJson } from "../http.ts";
import { activePrincipal, audit, authorizeAdmin, isObj, orgScope } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

function surfaceOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === value &&
      (url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1")
      ? value
      : null;
  } catch {
    return null;
  }
}

async function resolve(ctx: ApiCtx): Promise<void> {
  const user = ctx.actor?.p;
  if (!user || !(await activePrincipal(ctx.deps, user))) return sendJson(ctx.res, 403, { error: "forbidden" });
  const service = ctx.deps.documentConversations;
  if (!service) return sendJson(ctx.res, 503, { error: "unavailable" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const surface = surfaceOf(body.surface);
  if (
    !surface ||
    typeof body.documentId !== "string" ||
    !body.documentId.trim() ||
    (body.mode !== undefined && body.mode !== "shared" && body.mode !== "private")
  )
    return sendJson(ctx.res, 400, { error: "bad_request" });
  let previous: { scopeId: string; threadRef: string } | undefined;
  if (body.previous !== undefined) {
    if (
      !isObj(body.previous) ||
      typeof body.previous.scopeId !== "string" ||
      typeof body.previous.threadRef !== "string"
    )
      return sendJson(ctx.res, 400, { error: "bad_request" });
    previous = { scopeId: body.previous.scopeId, threadRef: body.previous.threadRef };
  }
  const result = await service.resolve({
    surface,
    documentId: body.documentId,
    principalId: user,
    ...(previous ? { previous } : {}),
    ...(body.mode ? { mode: body.mode as "private" | "shared" } : {}),
  });
  if (result.status !== "ok") {
    const status = { forbidden: 403, conflict: 409, unconfigured: 503 }[result.status];
    return sendJson(ctx.res, status, { error: result.status });
  }
  return sendJson(ctx.res, 200, result);
}

async function configure(ctx: ApiCtx): Promise<void> {
  if (ctx.actor?.imp) return refuseImpersonated(ctx.res);
  const admin = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!admin) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const surface = surfaceOf(body.surface);
  if (!surface || typeof body.projectId !== "string") return sendJson(ctx.res, 400, { error: "bad_request" });
  if (!ctx.deps.documentConversations) return sendJson(ctx.res, 503, { error: "unavailable" });
  if (!(await ctx.deps.documentConversations.configure(surface, body.projectId)))
    return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx, {
    principalId: admin.id,
    action: "documents.configure",
    resource: surface,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}

export const documentConversationRoutes: readonly Route<ApiCtx>[] = [
  {
    method: "POST",
    path: "/v1/web/documents/resolve",
    actor: "person",
    browser: "embed",
    auth: "source",
    handle: resolve,
  },
  {
    method: "PUT",
    path: "/v1/admin/documents/surface",
    actor: "person",
    browser: true,
    auth: "source",
    admin: {},
    handle: configure,
  },
];
