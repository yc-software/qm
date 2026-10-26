import { AsyncLocalStorage } from "node:async_hooks";
import { processOrgId } from "./config.ts";
import { scopeId, type ScopeId } from "./types.ts";

export interface Tenant {
  readonly orgId: string;
  readonly orgScope: ScopeId;
}

const current = new AsyncLocalStorage<Tenant>();

export function tenantFor(orgId: string): Tenant {
  return { orgId, orgScope: scopeId("org", orgId) };
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
