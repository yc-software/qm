import { withTenant } from "../../tenants/context.ts";
import { PLUGIN_SETTING_KEYS } from "../../tenants/settings.ts";
import { TenantSettingsInvalidError } from "../../tenants/settings-parse.ts";
import { sendJson } from "../http.ts";
import { requireOperatorControl } from "./background-work.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

async function putTenantSettings(ctx: ApiCtx): Promise<void> {
  if (!requireOperatorControl(ctx)) return;
  const { deps, body, res } = ctx;
  const settings = deps.tenantSettings;
  if (!settings) return sendJson(res, 404, { error: "not_found" });
  const env = isObj(body) ? body.env : undefined;
  if (!isObj(env) || Object.values(env).some((value) => typeof value !== "string"))
    return sendJson(res, 400, { error: "bad_request", message: "env must be an object of string values" });
  const slug = isObj(body) ? body.tenant : undefined;
  if (typeof slug !== "string" || !TENANT_SLUG.test(slug))
    return sendJson(res, 400, {
      error: "invalid_tenant",
      message: "tenant must be a tenant slug: lowercase letters, digits and inner hyphens",
    });
  const tenant = await settings.tenantForSlug(slug);
  if (!tenant)
    return sendJson(res, 404, { error: "unknown_tenant", message: `No tenant has the slug ${slug}`, tenant: slug });
  try {
    await withTenant(tenant, () => settings.update(env as Record<string, string>));
    return sendJson(res, 200, { tenant, updated: Object.keys(env) });
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
  { method: "PUT", path: "/v1/tenant-settings", actor: "system", auth: "source", handle: putTenantSettings },
];
