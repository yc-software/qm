import type { DurableMap } from "../../src/persistence/durable-map.ts";
import { currentTenant } from "../../src/tenants/context.ts";

export function partition<T>(rows: Map<string, Map<string, T>>): Map<string, T> {
  const key = currentTenant();
  const existing = rows.get(key);
  if (existing) return existing;
  const fresh = new Map<string, T>();
  rows.set(key, fresh);
  return fresh;
}

export function tenantMap<T>(): DurableMap<T> & { reads: string[] } {
  const rows = new Map<string, Map<string, T>>();
  const reads: string[] = [];
  const own = () => partition(rows);
  const unsupported = (): never => {
    throw new Error("not used by these tests");
  };
  return {
    reads,
    version: async () => String(Math.random()),
    async all() {
      reads.push(currentTenant());
      return [...own().values()];
    },
    async entries() {
      return [...own().entries()];
    },
    select: unsupported,
    selectEntries: unsupported,
    claimIds: unsupported,
    claimTenants: unsupported,
    deleteBefore: unsupported,
    claimTenantsWhere: unsupported,
    async get(id) {
      return own().get(id) ?? null;
    },
    async put(id, value) {
      own().set(id, value);
    },
    async putIfAbsent(id, value) {
      const existing = own().get(id);
      if (existing !== undefined) return existing;
      own().set(id, value);
      return value;
    },
    async insertIfAbsent(id, value) {
      if (own().has(id)) return false;
      own().set(id, value);
      return true;
    },
    merge: unsupported,
    async update(id, fn) {
      const existing = own().get(id);
      if (existing === undefined) return null;
      const next = fn(existing);
      own().set(id, next);
      return next;
    },
    mutateMany: unsupported,
    async deleteIf(id, predicate) {
      const existing = own().get(id);
      if (existing === undefined || !predicate(existing)) return false;
      own().delete(id);
      return true;
    },
    async delete(id) {
      own().delete(id);
    },
    async deleteMany(ids) {
      for (const id of ids) own().delete(id);
    },
    async take(id) {
      const existing = own().get(id) ?? null;
      own().delete(id);
      return existing;
    },
  };
}
