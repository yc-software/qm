import type { ScopeId } from "../types.ts";

export type AdminRole = "org_admin";

export const ADMIN_GRANT_BOOTSTRAP_ACTOR = "system";
export const ADMIN_GRANT_BOOTSTRAP_TIME = 0;

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

export function isBootstrapAdminGrant(grant: AdminGrant): boolean {
  return grant.grantedBy === ADMIN_GRANT_BOOTSTRAP_ACTOR && grant.createdAt === ADMIN_GRANT_BOOTSTRAP_TIME;
}

function bootstrapAdminGrant(grant: AdminGrant): AdminGrant {
  return {
    ...grant,
    grantedBy: ADMIN_GRANT_BOOTSTRAP_ACTOR,
    createdAt: ADMIN_GRANT_BOOTSTRAP_TIME,
  };
}

export interface AdminGrantPersistence {
  all(): Promise<AdminGrant[]>;
  put(g: AdminGrant): Promise<void>;
  remove(principalId: string, scopeId: ScopeId, role: AdminRole): Promise<void>;
  reconcileBootstrap(grants: readonly AdminGrant[]): Promise<void>;
}

export function createMemoryAdminGrantPersistence(): AdminGrantPersistence {
  let rows = new Map<string, AdminGrant>();
  const all = () =>
    [...rows.entries()]
      .sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      })
      .map(([, grant]) => grant);
  return {
    async all() {
      return all();
    },
    async put(g) {
      rows.set(grantKey(g.principalId, g.scopeId, g.role), g);
    },
    async remove(principalId, scopeId, role) {
      rows.delete(grantKey(principalId, scopeId, role));
    },
    async reconcileBootstrap(grants) {
      const desired = new Map(
        grants.map((grant) => [grantKey(grant.principalId, grant.scopeId, grant.role), bootstrapAdminGrant(grant)]),
      );
      const next = new Map(rows);
      for (const [key, grant] of desired) {
        if (!next.has(key)) next.set(key, grant);
      }
      for (const [key, grant] of next) {
        if (isBootstrapAdminGrant(grant) && !desired.has(key)) next.delete(key);
      }
      rows = next;
    },
  };
}

export interface AdminGrantStore {
  ready(): Promise<void>;
  list(): Promise<AdminGrant[]>;
  add(g: AdminGrant): Promise<void>;
  revoke(principalId: string, scopeId: ScopeId, role: AdminRole): Promise<void>;
}

export interface AdminGrantStoreOptions {
  bootstrap?: AdminGrant[];
}

export function createAdminGrantStore(
  persist: AdminGrantPersistence = createMemoryAdminGrantPersistence(),
  opts: AdminGrantStoreOptions = {},
): AdminGrantStore {
  const bootstrap = opts.bootstrap ?? [];
  let readyP: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!readyP) {
      readyP = persist.reconcileBootstrap(bootstrap).catch((e) => {
        readyP = null;
        throw e;
      });
    }
    return readyP;
  }
  return {
    ready,
    async list() {
      await ready();
      return persist.all();
    },
    async add(g) {
      await ready();
      await persist.put(g);
    },
    async revoke(principalId, scopeId, role) {
      await ready();
      await persist.remove(principalId, scopeId, role);
    },
  };
}
