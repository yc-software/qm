import { reportFailureAs } from "../util/errors.ts";
import { boundTenant, isTenantId, pinTenant, withoutTenant, withTenant } from "../../plugins/chassis/src/tenant.ts";

export { boundTenant, isTenantId, pinTenant, withoutTenant, withTenant };

export function tenantClaim(): { tenant?: string } {
  const tenant = boundTenant();
  return tenant === undefined ? {} : { tenant };
}

export function currentTenant(): string {
  const id = boundTenant();
  if (id === undefined) throw new Error("No tenant is bound to this work");
  return id;
}

interface KnownTenants {
  install: string;
  sole: string | undefined;
}

let known: KnownTenants | undefined;

export function registerTenants(install: string, all: readonly string[]): void {
  known = { install, sole: all.length === 1 ? all[0] : undefined };
}

export function cacheTenant(): string {
  const bound = boundTenant();
  if (bound !== undefined) return bound;
  if (!known) return "";
  if (known.sole !== undefined) return known.sole;
  throw new Error("No tenant is bound to this work");
}

export function unboundTenantAllowed(): boolean {
  return !known || known.sole !== undefined;
}

export function withInstallTenant<T>(fn: () => T): T {
  return known ? withTenant(known.install, fn) : fn();
}

export function isInstallTenant(): boolean {
  return !known || cacheTenant() === known.install;
}

export function perTenant<V>(create: () => V): () => V {
  const values = new Map<string, V>();
  return () => {
    const id = cacheTenant();
    const existing = values.get(id);
    if (existing !== undefined) return existing;
    const value = create();
    values.set(id, value);
    return value;
  };
}

export interface TenantLoader {
  load(): Promise<void>;
  forEachLoaded(fn: () => Promise<unknown>): Promise<void>;
}

export function createTenantLoader(loaders: ReadonlyArray<() => Promise<unknown>>): TenantLoader {
  const loads = new Map<string, Promise<void>>();
  return {
    load() {
      const id = cacheTenant();
      const existing = loads.get(id);
      if (existing) return existing;
      const run = Promise.all(loaders.map((loader) => loader())).then(() => undefined);
      loads.set(id, run);
      run.catch(() => loads.get(id) === run && loads.delete(id));
      return run;
    },
    async forEachLoaded(fn) {
      for (const id of [...loads.keys()])
        await (id ? withTenant(id, fn) : fn()).catch(reportFailureAs("tenants: refresh a loaded tenant", undefined));
    },
  };
}
