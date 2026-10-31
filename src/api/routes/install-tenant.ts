import { sendJson } from "../http.ts";
import { requireOperatorControl } from "./background-work.ts";
import type { ApiCtx, Route } from "./route.ts";

async function installTenant(ctx: ApiCtx): Promise<void> {
  if (!requireOperatorControl(ctx)) return;
  const install = ctx.deps.installTenant;
  if (!install) return sendJson(ctx.res, 503, { error: "install_tenant_unavailable" });
  return sendJson(ctx.res, 200, await install());
}

export const installTenantRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "PUT", path: "/v1/install/tenant", actor: "system", auth: "source", unbound: true, handle: installTenant },
];
