import { AmbiguousInstallTenant } from "../../tenants/install.ts";
import { sendJson } from "../http.ts";
import { requireOperatorControl } from "./background-work.ts";
import type { ApiCtx, Route } from "./route.ts";

async function installTenant(ctx: ApiCtx): Promise<void> {
  if (!requireOperatorControl(ctx)) return;
  const install = ctx.deps.installTenant;
  if (!install) return sendJson(ctx.res, 503, { error: "install_tenant_unavailable" });
  try {
    const installed = await install();
    const ownership = ctx.deps.backgroundOwnership;
    if (ownership) await ownership.store.claimIfNeverSet(ownership.deploymentId);
    return sendJson(ctx.res, 200, installed);
  } catch (error) {
    if (!(error instanceof AmbiguousInstallTenant)) throw error;
    return sendJson(ctx.res, 409, {
      error: "ambiguous_install_tenant",
      message: error.message,
      tenants: error.tenants,
    });
  }
}

export const installTenantRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "PUT", path: "/v1/install/tenant", actor: "system", auth: "source", unbound: true, handle: installTenant },
];
