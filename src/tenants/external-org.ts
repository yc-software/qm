import { orgId } from "../config.ts";
import { bootTenant } from "./boot.ts";
import { boundTenant } from "./context.ts";
import { loadedTenantSettings, tenantSettings } from "./settings.ts";

export function externalOrgId(): string {
  const tenant = boundTenant();
  const boot = bootTenant();
  if (tenant === undefined && boot === undefined) throw new Error("no tenant is bound");
  if (tenant === undefined || tenant === boot) return tenantSettings().orgSlug ?? orgId();
  const settings = loadedTenantSettings();
  if (!settings) throw new Error("tenant settings are not loaded");
  return settings.orgSlug ?? tenant;
}
