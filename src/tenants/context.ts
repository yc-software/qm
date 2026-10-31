import { boundTenant, isTenantId, tenantId, tenantStore, withTenant } from "../../plugins/chassis/src/tenant.ts";

export { boundTenant, isTenantId, withTenant };

export function withoutTenant<T>(fn: () => T): T {
  return tenantStore.exit(fn);
}

export function enterTenant(id: string): void {
  tenantStore.enterWith(tenantId(id));
}

export function currentTenant(): string {
  const id = tenantStore.getStore();
  if (!id) throw new Error("No tenant is bound to this operation");
  return id;
}
