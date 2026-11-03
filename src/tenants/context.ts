import {
  boundTenant,
  isTenantId,
  onFirstBind,
  pinTenant,
  tenantReady,
  withoutTenant,
  withTenant,
} from "../../plugins/chassis/src/tenant.ts";

export { boundTenant, isTenantId, onFirstBind, pinTenant, tenantReady, withoutTenant, withTenant };

export function currentTenant(): string {
  const id = boundTenant();
  if (id === undefined) throw new Error("No tenant is bound to this work");
  return id;
}

export function perTenant<V>(create: () => V): () => V {
  const values = new Map<string, V>();
  return () => {
    const id = currentTenant();
    const existing = values.get(id);
    if (existing !== undefined) return existing;
    const value = create();
    values.set(id, value);
    return value;
  };
}
