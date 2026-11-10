import {
  ambientTenant,
  boundTenant,
  explicitTenantId,
  isTenantId,
  pinTenant,
  Tenant,
  withoutTenant,
  withTenant,
} from "../../plugins/chassis/src/tenant.ts";

export { ambientTenant, boundTenant, explicitTenantId, isTenantId, pinTenant, Tenant, withoutTenant, withTenant };

export function currentTenant(): string {
  const id = boundTenant();
  if (id === undefined) throw new Error("No tenant is bound to this work");
  return id;
}
