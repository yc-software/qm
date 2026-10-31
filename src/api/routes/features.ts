import { scopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

async function features(ctx: ApiCtx): Promise<void> {
  const principalId = ctx.actor?.p ?? (ctx.url.searchParams.get("principalId") ?? "").trim();
  if (!principalId) return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  const enabled = await ctx.deps.featureFlags?.enabledFor(scopeId("personal", principalId));
  sendJson(ctx.res, 200, { enabled: [...(enabled ?? [])] });
}

export const featureRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/features", actor: "query.principalId", auth: "source", handle: features },
];
