import { currentTenant } from "../tenants/context.ts";
import { present } from "./pg-values.ts";

export interface MemoryRows<T extends { id: string }> {
  get(id: string): T | null;
  insertIfAbsent(value: T): boolean;
  update(id: string, apply: (value: T) => T): T | null;
  delete(id: string): void;
  where(match: (value: T) => boolean): T[];
  acrossTenants(match: (value: T) => boolean): Array<T & { tenantId: string }>;
  purgeAcrossTenants(match: (value: T) => boolean): number;
}

const byId = <T>([a]: [string, T], [b]: [string, T]): number => Number(a > b) - Number(a < b);

export function createMemoryRows<T extends { id: string }>(): MemoryRows<T> {
  const tenants = new Map<string, Map<string, T>>();
  const mine = (): Map<string, T> => {
    const tenant = currentTenant();
    if (!tenants.has(tenant)) tenants.set(tenant, new Map());
    return tenants.get(tenant)!;
  };
  const clean = (value: T): T => structuredClone(present<T>(value as unknown as Record<string, unknown>));
  return {
    get(id) {
      const value = mine().get(id);
      return value ? structuredClone(value) : null;
    },
    insertIfAbsent(value) {
      const rows = mine();
      if (rows.has(value.id)) return false;
      rows.set(value.id, clean(value));
      return true;
    },
    update(id, apply) {
      const rows = mine();
      const current = rows.get(id);
      if (!current) return null;
      const next = clean({ ...apply(structuredClone(current)), id });
      rows.set(id, next);
      return structuredClone(next);
    },
    delete: (id) => void mine().delete(id),
    where: (match) =>
      [...mine().entries()]
        .sort(byId)
        .map(([, value]) => value)
        .filter(match)
        .map((value) => structuredClone(value)),
    acrossTenants: (match) =>
      [...tenants.entries()].sort(byId).flatMap(([tenantId, rows]) =>
        [...rows.entries()]
          .sort(byId)
          .map(([, value]) => value)
          .filter(match)
          .map((value) => ({ ...structuredClone(value), tenantId })),
      ),
  };
}
