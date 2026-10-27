import { AsyncLocalStorage } from "node:async_hooks";
import { processOrgId, processTenantSettings } from "./config.ts";
import { configurePgTenantSource } from "./persistence/pg-pool.ts";
import type { TenantSettings } from "./tenants/registry.ts";
import { scopeId, type ScopeId } from "./types.ts";
import { reportFailure } from "./util/errors.ts";

export interface Tenant {
  readonly id?: string;
  readonly slug?: string;
  readonly orgId: string;
  readonly orgScope: ScopeId;
}

const current = new AsyncLocalStorage<Tenant>();

configurePgTenantSource(() => current.getStore()?.id);

export function tenantFor(orgId: string, id?: string, slug?: string): Tenant {
  return { orgId, orgScope: scopeId("org", orgId), ...(id ? { id } : {}), ...(slug ? { slug } : {}) };
}

let processTenant: Tenant | undefined;

export function tenant(): Tenant {
  const scoped = current.getStore();
  if (scoped) return scoped;
  const orgId = processOrgId();
  if (processTenant?.orgId !== orgId) processTenant = tenantFor(orgId);
  return processTenant;
}

export function withTenant<T>(t: Tenant, fn: () => T): T {
  return current.run(t, fn);
}

let registered = new Map<string, TenantSettings>();
let home: { tenant: Tenant; settings: TenantSettings } | undefined;

export function registerTenantSettings(list: readonly TenantSettings[]): void {
  registered = new Map(list.flatMap((settings) => (settings.id ? [[settings.id, settings] as const] : [])));
}

export function tenantSettings(t: Tenant = tenant()): TenantSettings {
  if (t.id) {
    const own = registered.get(t.id);
    if (!own) throw new Error(`tenant ${t.slug ?? t.id} has no registered settings`);
    return own;
  }
  if (home?.tenant !== t) home = { tenant: t, settings: processTenantSettings(t) };
  return home.settings;
}

export function perTenant<T>(create: () => T): () => T {
  const states = new Map<string, T>();
  return () => {
    const t = tenant();
    const key = t.id ?? t.orgId;
    let state = states.get(key);
    if (state === undefined) {
      state = create();
      states.set(key, state);
    }
    return state;
  };
}

export function reportForeignTenant(claimed: string | undefined, credential: string): void {
  const serving = tenant().orgId;
  if (claimed === undefined || claimed === serving) return;
  reportFailure(
    "tenant: credential issued for another tenant",
    new Error(`${credential} names tenant ${claimed}; this process serves ${serving}`),
  );
}
