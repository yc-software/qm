import { tenantRootScope, withTenant } from "../../tenants/context.ts";
import { importTenantSettings, unknownTenantImportKeys } from "../../tenants/settings-import.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { requireOperatorControl } from "./background-work.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function putTenantSettings(ctx: ApiCtx): Promise<void> {
  if (!requireOperatorControl(ctx)) return;
  const { deps, body, res } = ctx;
  if (!deps.tenantSettings || !deps.modelCredentials || !deps.config) return sendJson(res, 404, { error: "not_found" });
  const env = isObj(body) ? body.env : undefined;
  if (!isObj(env) || Object.values(env).some((value) => typeof value !== "string"))
    return sendJson(res, 400, { error: "bad_request", message: "env must be an object of string values" });
  const unknown = unknownTenantImportKeys(env);
  if (unknown.length)
    return sendJson(res, 400, { error: "not_tenant_settings", message: `Not tenant settings: ${unknown.join(", ")}` });
  const tenant = await deps.tenantSettings.onlyTenant();
  if (!tenant)
    return sendJson(res, 409, { error: "no_install_tenant", message: "This install needs exactly one tenant" });
  try {
    const updated = await withTenant(tenant, () =>
      importTenantSettings(env as Record<string, string>, {
        settings: deps.tenantSettings!,
        modelCredentials: deps.modelCredentials!,
        config: deps.config!,
        rootScope: tenantRootScope(),
        actor: "operator settings push",
      }),
    );
    return sendJson(res, 200, { tenant, updated });
  } catch (error) {
    return sendJson(res, 400, { error: "invalid_tenant_settings", message: errMessage(error) });
  }
}

export const tenantSettingsRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "PUT", path: "/v1/tenant-settings", actor: "system", auth: "source", handle: putTenantSettings },
];
