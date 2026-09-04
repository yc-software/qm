import type { ScopeId } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";

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
  remove(principalId: string, scopeId: ScopeId, role: AdminRole): Promise<void>;
}

export function createMapAdminGrantPersistence(
  map: DurableMap<AdminGrant> = createMemoryMap<AdminGrant>(),
): AdminGrantPersistence {
  return {
    async all() {
      return map.all();
    },
    async put(g) {
      await map.put(grantKey(g.principalId, g.scopeId, g.role), g);
    },
    async remove(principalId, scopeId, role) {
      await map.delete(grantKey(principalId, scopeId, role));
    },
  };
}

export const createMemoryAdminGrantPersistence = (): AdminGrantPersistence => createMapAdminGrantPersistence();

export interface AdminGrantStore {
  list(): Promise<AdminGrant[]>;
  add(g: AdminGrant): Promise<void>;
  revoke(principalId: string, scopeId: ScopeId, role: AdminRole): Promise<void>;
}

export interface AdminGrantStoreOptions {
  seed?: AdminGrant[];
}

export function createAdminGrantStore(
  persist: AdminGrantPersistence = createMemoryAdminGrantPersistence(),
  opts: AdminGrantStoreOptions = {},
): AdminGrantStore {
  const seeds = opts.seed ?? [];
  let seededP: Promise<void> | null = null;
  function ensureSeeded(): Promise<void> {
    if (!seededP) {
      seededP = (async () => {
        if (!seeds.length) return;
        if ((await persist.all()).length > 0) return;
        for (const g of seeds) await persist.put({ grantedBy: "system", createdAt: 0, ...g });
      })().catch((e) => {
        seededP = null;
        throw e;
      });
    }
    return seededP;
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
    async revoke(principalId, scopeId, role) {
      await ensureSeeded();
      await persist.remove(principalId, scopeId, role);
    },
  };
}
