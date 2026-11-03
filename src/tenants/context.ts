import { boundTenant, isTenantId, pinTenant, withoutTenant, withTenant } from "../../plugins/chassis/src/tenant.ts";

export { boundTenant, isTenantId, pinTenant, withoutTenant, withTenant };

export function tenantClaim(): { tenant?: string } {
  const tenant = boundTenant();
  return tenant === undefined ? {} : { tenant };
}

export function currentTenant(): string {
  const id = boundTenant();
  if (id === undefined) throw new Error("No tenant is bound to this work");
  return id;
}
