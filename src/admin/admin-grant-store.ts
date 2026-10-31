import type { ScopeId } from "../types.ts";
import { currentTenant } from "../tenants/context.ts";

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
  all(): Promise<AdminGrant[]>;
  put(g: AdminGrant): Promise<void>;
  insertIfAbsent(g: AdminGrant): Promise<boolean>;
  remove(principalId: string, scopeId: ScopeId, role: AdminRole): Promise<void>;
}

export interface AdminGrantStore {
  list(): Promise<AdminGrant[]>;
  add(g: AdminGrant): Promise<void>;
  addIfAbsent(g: AdminGrant): Promise<boolean>;
  revoke(principalId: string, scopeId: ScopeId, role: AdminRole): Promise<void>;
}

export interface AdminGrantStoreOptions {
  seed?: () => AdminGrant[] | Promise<AdminGrant[]>;
}

export function createAdminGrantStore(
  persist: AdminGrantPersistence,
  opts: AdminGrantStoreOptions = {},
): AdminGrantStore {
  const seeded = new Map<string, Promise<void>>();
  function ensureSeeded(): Promise<void> {
    const tenant = currentTenant();
    let pending = seeded.get(tenant);
    if (!pending) {
      pending = (async () => {
        const seeds = (await opts.seed?.()) ?? [];
        if (!seeds.length) return;
        if ((await persist.all()).length > 0) return;
        for (const g of seeds) await persist.put({ grantedBy: "system", createdAt: 0, ...g });
      })().catch((e) => {
        seeded.delete(tenant);
        throw e;
      });
      seeded.set(tenant, pending);
    }
    return pending;
  }
  return {
    async list() {
      await ensureSeeded();
      return persist.all();
    },
    async add(g) {
      await ensureSeeded();
      await persist.put(g);
    },
    async addIfAbsent(g) {
      await ensureSeeded();
      return persist.insertIfAbsent(g);
    },
    async revoke(principalId, scopeId, role) {
      await ensureSeeded();
      await persist.remove(principalId, scopeId, role);
    },
  };
}
