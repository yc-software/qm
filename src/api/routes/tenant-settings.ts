import { currentTenant, isTenantId } from "../../tenants/context.ts";
import { PLUGIN_SETTING_KEYS } from "../../tenants/settings.ts";
import { TenantSettingsInvalidError } from "../../tenants/settings-parse.ts";
import { sendJson } from "../http.ts";
import { requireOperatorControl } from "./background-work.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

export async function operatorTenant(ctx: ApiCtx): Promise<string | null> {
  const { deps, body, res } = ctx;
  if (!deps.tenantSettings) {
    sendJson(res, 404, { error: "not_found" });
    return null;
  }
  const tenant = isObj(body) ? body.tenant : undefined;
  if (!isTenantId(tenant)) {
    sendJson(res, 400, { error: "invalid_tenant", message: "tenant must be a tenant id: a lowercase uuid" });
    return null;
  }
  if (await deps.tenantSettings.hasTenant(tenant)) return tenant;
  sendJson(res, 404, { error: "unknown_tenant", message: `No tenant has the id ${tenant}`, tenant });
  return null;
}

async function putTenantSettings(ctx: ApiCtx): Promise<void> {
  const { deps, body, res } = ctx;
  if (!ctx.operator) {
    requireOperatorControl(ctx);
    return;
  }
  const env = isObj(body) ? body.env : undefined;
  if (!isObj(env) || Object.values(env).some((value) => typeof value !== "string"))
    return sendJson(res, 400, { error: "bad_request", message: "env must be an object of string values" });
  try {
    await deps.tenantSettings!.update(env as Record<string, string>);
    return sendJson(res, 200, { tenant: currentTenant(), updated: Object.keys(env) });
  } catch (error) {
    if (!(error instanceof TenantSettingsInvalidError)) throw error;
    return sendJson(res, 400, { error: error.code, message: error.message });
  }
}

async function getPluginSettings(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tenantSettings) return sendJson(ctx.res, 404, { error: "not_found" });
  const { values } = await ctx.deps.tenantSettings.get();
  return sendJson(ctx.res, 200, {
    values: Object.fromEntries(PLUGIN_SETTING_KEYS.flatMap((key) => (values[key] ? [[key, values[key]]] : []))),
  });
}

export const tenantSettingsRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/plugin-settings", auth: "source", handle: getPluginSettings },
  {
    method: "PUT",
    path: "/v1/tenant-settings",
    actor: "system",
    auth: "source",
    operator: true,
    handle: putTenantSettings,
  },
];
