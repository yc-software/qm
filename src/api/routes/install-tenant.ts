import { InstallTenantConflict } from "../../tenants/install.ts";
import { sendJson } from "../http.ts";
import { requireOperatorControl } from "./background-work.ts";
import type { ApiCtx, Route } from "./route.ts";

async function installTenant(ctx: ApiCtx): Promise<void> {
  if (!requireOperatorControl(ctx)) return;
  const install = ctx.deps.installTenant;
  if (!install) return sendJson(ctx.res, 503, { error: "install_tenant_unavailable" });
  try {
    return sendJson(ctx.res, 200, await install());
  } catch (error) {
    if (error instanceof InstallTenantConflict)
      return sendJson(ctx.res, 409, { error: "install_tenant_conflict", message: error.message });
    throw error;
  }
}

export const installTenantRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "PUT", path: "/v1/install/tenant", actor: "system", auth: "source", unbound: true, handle: installTenant },
];
