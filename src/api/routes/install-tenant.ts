import { validTenantSlug } from "../../tenants/install.ts";
import { sendJson } from "../http.ts";
import { requireOperatorControl } from "./background-work.ts";
import type { ApiCtx, Route } from "./route.ts";

async function installTenant(ctx: ApiCtx): Promise<void> {
  if (!requireOperatorControl(ctx)) return;
  const install = ctx.deps.installTenant;
  if (!install) return sendJson(ctx.res, 503, { error: "install_tenant_unavailable" });
  const slug = (ctx.body as { tenant?: unknown } | undefined)?.tenant;
  if (!validTenantSlug(slug))
    return sendJson(ctx.res, 400, {
      error: "invalid_tenant",
      message: "tenant must be a tenant slug: lowercase letters, digits and inner hyphens",
    });
  return sendJson(ctx.res, 200, await install(slug));
}

export const installTenantRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "PUT", path: "/v1/install/tenant", actor: "system", auth: "source", unbound: true, handle: installTenant },
];
