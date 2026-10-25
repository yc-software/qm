import { AsyncLocalStorage } from "node:async_hooks";
import { processOrgId } from "./config.ts";
import { scopeId, type ScopeId } from "./types.ts";
import { reportFailure } from "./util/errors.ts";

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

export function perTenant<T>(create: () => T): () => T {
  const states = new Map<string, T>();
  return () => {
    const { orgId } = tenant();
    let state = states.get(orgId);
    if (state === undefined) {
      state = create();
      states.set(orgId, state);
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
