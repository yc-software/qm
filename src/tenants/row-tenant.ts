import type { TenantList } from "./resolver.ts";

export type RowTenants = (table: string, columns: readonly string[], value: string) => Promise<string[]>;

export function installRowTenants(tenants: TenantList): RowTenants {
  return () => tenants();
}
