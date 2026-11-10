import type { Tenant } from "../tenants/context.ts";
import type { ScopeId } from "../types.ts";

export type AdminRole = "org_admin";

export interface AdminGrant {
  principalId: string;
  scopeId: ScopeId;
  role: AdminRole;
  grantedBy?: string;
  createdAt?: number;
}

export function grantKey(principalId: string, scopeId: ScopeId, role: AdminRole): string {
  return JSON.stringify([principalId, scopeId, role]);
}

export interface AdminGrantPersistence {
  all(tenant: Tenant): Promise<AdminGrant[]>;
  put(tenant: Tenant, g: AdminGrant): Promise<void>;
  insertIfAbsent(tenant: Tenant, g: AdminGrant): Promise<boolean>;
  remove(tenant: Tenant, principalId: string, scopeId: ScopeId, role: AdminRole): Promise<void>;
}

export interface AdminGrantStore {
  list(tenant: Tenant): Promise<AdminGrant[]>;
  add(tenant: Tenant, g: AdminGrant): Promise<void>;
  addIfAbsent(tenant: Tenant, g: AdminGrant): Promise<boolean>;
  revoke(tenant: Tenant, principalId: string, scopeId: ScopeId, role: AdminRole): Promise<void>;
}

export interface AdminGrantStoreOptions {
  seed?: AdminGrant[];
  seedsTenant?: (tenant: Tenant) => boolean;
  beforeSeed?: (tenant: Tenant, grants: readonly AdminGrant[]) => Promise<unknown>;
}

export function createAdminGrantStore(
  persist: AdminGrantPersistence,
  opts: AdminGrantStoreOptions = {},
): AdminGrantStore {
  const seeds = opts.seed ?? [];
  const seeding = new Map<string, Promise<void>>();
  function ensureSeeded(tenant: Tenant): Promise<void> {
    let done = seeding.get(tenant.id);
    if (!done) {
      done = (async () => {
        if (!seeds.length || (opts.seedsTenant && !opts.seedsTenant(tenant))) return;
        if ((await persist.all(tenant)).length > 0) return;
        await opts.beforeSeed?.(tenant, seeds);
        for (const g of seeds) await persist.put(tenant, { grantedBy: "system", createdAt: 0, ...g });
      })().catch((e) => {
        seeding.delete(tenant.id);
        throw e;
      });
      seeding.set(tenant.id, done);
    }
    return done;
  }
  return {
    async list(tenant) {
      await ensureSeeded(tenant);
      return persist.all(tenant);
    },
    async add(tenant, g) {
      await ensureSeeded(tenant);
      await persist.put(tenant, g);
    },
    async addIfAbsent(tenant, g) {
      await ensureSeeded(tenant);
      return persist.insertIfAbsent(tenant, g);
    },
    async revoke(tenant, principalId, scopeId, role) {
      await ensureSeeded(tenant);
      await persist.remove(tenant, principalId, scopeId, role);
    },
  };
}
