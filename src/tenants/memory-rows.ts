import { currentTenant } from "./context.ts";

export function tenantRows<T>(): () => Map<string, T> {
  const tenants = new Map<string, Map<string, T>>();
  return () => {
    const tenant = currentTenant();
    const rows = tenants.get(tenant) ?? new Map<string, T>();
    tenants.set(tenant, rows);
    return rows;
  };
}

export function sortedRows<T>(rows: Map<string, T>): T[] {
  return [...rows.keys()].sort().map((id) => rows.get(id)!);
}
