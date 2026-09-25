import { parseScopeId, type Principal } from "../../types.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";
function conversationPrincipals(ctx: ApiCtx): Principal[] | null {
  const capability = ctx.capability!;
  const { kind } = parseScopeId(capability.scopeId);
  if ((kind === "channel" || kind === "group") && !capability.members?.length) return null;
  const principals = new Map((capability.members ?? []).map((p) => [p.id.toLowerCase(), p]));
  if (!principals.has(capability.actorId.toLowerCase()))
    principals.set(capability.actorId.toLowerCase(), { id: capability.actorId, type: "internal" });
  return [...principals.values()];
}
async function search(ctx: ApiCtx): Promise<void> {
  if (!ctx.capability)
    return sendJson(ctx.res, 401, { error: "capability_required", message: "agent capability token required" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return sendJson(ctx.res, 400, { error: "bad_request", message: "query required" });
  const principals = conversationPrincipals(ctx);
  if (!principals)
    return sendJson(ctx.res, 409, {
      error: "principal_set_unavailable",
      message: "search requires the complete principal set for a shared conversation",
    });
  const result = await ctx.app.search(query, principals, typeof body.limit === "number" ? body.limit : undefined);
  ctx.deps.auditLog?.record({
    at: Date.now(),
    principalId: ctx.capability.actorId,
    action: "search.query",
    resource: "core-search",
    scopeLabel: ctx.capability.scopeId,
    detail: JSON.stringify({
      principals: principals.map((p) => p.id).sort(),
      hitCount: result.hits.length,
      backends: [...new Set(result.hits.map((h) => h.backend))].sort(),
      failedBackends: result.failedBackends,
    }),
  });
  return sendJson(ctx.res, 200, result);
}
export const searchRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/search", auth: "either", handle: search },
];
