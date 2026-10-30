import { boundTenant } from "../tenants/context.ts";
import { present } from "./pg-values.ts";

export interface MemoryRows<T extends { id: string }> {
  get(id: string): T | null;
  insertIfAbsent(value: T): boolean;
  update(id: string, apply: (value: T) => T): T | null;
  delete(id: string): void;
  where(match: (value: T) => boolean): T[];
  tenanted(match: (value: T) => boolean): Array<T & { tenantId: string | undefined }>;
}

export function createMemoryRows<T extends { id: string }>(): MemoryRows<T> {
  const rows = new Map<string, { value: T; tenantId: string | undefined }>();
  const clean = (value: T): T => structuredClone(present<T>(value as unknown as Record<string, unknown>));
  const sorted = () => [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
  return {
    get: (id) => {
      const row = rows.get(id);
      return row ? structuredClone(row.value) : null;
    },
    insertIfAbsent(value) {
      if (rows.has(value.id)) return false;
      rows.set(value.id, { value: clean(value), tenantId: boundTenant() });
      return true;
    },
    update(id, apply) {
      const row = rows.get(id);
      if (!row) return null;
      row.value = clean({ ...apply(structuredClone(row.value)), id });
      return structuredClone(row.value);
    },
    delete: (id) => void rows.delete(id),
    where: (match) =>
      sorted()
        .filter((row) => match(row.value))
        .map((row) => structuredClone(row.value)),
    tenanted: (match) =>
      sorted()
        .filter((row) => match(row.value))
        .map((row) => ({ ...structuredClone(row.value), tenantId: row.tenantId })),
  };
}
