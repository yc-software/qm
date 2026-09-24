import { sendJson } from "../http.ts";
import { activePrincipal, audit, authorizeAdmin, isObj, orgScope } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";
import { errMessage } from "../../util/errors.ts";

async function handle(ctx: ApiCtx, kind: "org" | "personal") {
  const { res, deps, method, body } = ctx;
  if (!deps.designSystems) return sendJson(res, 404, { error: "not_found" });
  const actor = kind === "org" ? (await authorizeAdmin(ctx, orgScope(deps)))?.id : ctx.actor?.p;
  if (!actor) {
    if (kind === "personal") sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (!(await activePrincipal(deps, actor))) return sendJson(res, 403, { error: "forbidden" });
  if (method === "GET") return sendJson(res, 200, await deps.designSystems.state(actor));
  try {
    if (method === "POST") await deps.designSystems.create(kind, actor);
    else {
      if (
        !isObj(body) ||
        !(body.deploymentId === null || (typeof body.deploymentId === "string" && body.deploymentId.length <= 200))
      )
        return sendJson(res, 400, { error: "bad_request", message: "deploymentId must be an app ID or null." });
      await deps.designSystems.select(kind, actor, body.deploymentId as string | null);
    }
    audit(deps, {
      principalId: actor,
      action: `design_system.${method === "POST" ? "create" : "select"}`,
      resource: kind,
      scopeLabel: kind === "org" ? orgScope(deps) : `personal:${actor}`,
    });
    return sendJson(res, 200, await deps.designSystems.state(actor));
  } catch (error) {
    return sendJson(res, 400, { error: "design_system_failed", message: errMessage(error) });
  }
}

export const designSystemRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...["GET", "PUT", "POST"].map((method) => ({
    method,
    path: "/v1/admin/design-system",
    auth: "source" as const,
    handle: (ctx: ApiCtx) => handle(ctx, "org"),
  })),
  ...["GET", "PUT", "POST"].map((method) => ({
    method,
    path: "/v1/design-system",
    auth: "source" as const,
    handle: (ctx: ApiCtx) => handle(ctx, "personal"),
  })),
];
