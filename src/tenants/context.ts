import { boundTenant, isTenantId, pinTenant, withoutTenant, withTenant } from "../../plugins/chassis/src/tenant.ts";
import { hashId } from "../util/crypto.ts";

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

interface SettledTenancy {
  install: string;
  sole: string | undefined;
}

let settled: SettledTenancy | undefined;
let refusal: string | undefined;

export class TenantUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantUnavailable";
  }
}

export function refuseTenancy(reason: string | undefined): void {
  refusal = reason;
}

export function assertTenancyAllowed(): void {
  if (refusal !== undefined) throw new TenantUnavailable(refusal);
}

export function registerTenants(install: string, sole: string | undefined): void {
  settled = { install, sole };
}

export function soleTenantNow(): string | undefined {
  return settled?.sole;
}

export function installTenantNow(): string | undefined {
  return settled?.install;
}

export function tenantScopedId(id: string): string {
  const tenant = boundTenant();
  const install = installTenantNow();
  return tenant === undefined || install === undefined || tenant === install ? id : `t-${hashId([tenant], 10)}:${id}`;
}

export function unboundTenantAllowed(): boolean {
  return !settled || soleTenantNow() !== undefined;
}

export function cacheTenant(): string {
  const bound = boundTenant();
  if (bound !== undefined) return bound;
  const sole = soleTenantNow();
  if (sole !== undefined) return sole;
  if (unboundTenantAllowed()) return "";
  throw new Error("No tenant is bound to this work");
}

export function withInstallTenant<T>(fn: () => T): T {
  const install = installTenantNow();
  return install === undefined ? fn() : withTenant(install, fn);
}

export function isInstallTenant(): boolean {
  const install = installTenantNow();
  return install === undefined || cacheTenant() === install;
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
  };
}
