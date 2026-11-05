import { currentTenant, withTenant } from "../tenants/context.ts";

interface TenantRuntime {
  start(): void;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

export function createTenantSlackRuntimes(opts: {
  runtimeFor: (tenant: string) => TenantRuntime;
  tenants: () => Promise<(string | undefined)[]>;
  onError: (error: unknown) => void;
}) {
  const runtimes = new Map<string, TenantRuntime>();
  let running = false;
  const ensure = (tenant: string): TenantRuntime => {
    let runtime = runtimes.get(tenant);
    if (!runtime) {
      runtime = withTenant(tenant, () => opts.runtimeFor(tenant));
      runtimes.set(tenant, runtime);
    }
    if (running) withTenant(tenant, () => runtime.start());
    return runtime;
  };
  return {
    async reconcile(): Promise<void> {
      return ensure(currentTenant()).reconcile();
    },
    start(): void {
      running = true;
      void opts
        .tenants()
        .then((tenants) => new Set(tenants).forEach((tenant) => tenant && ensure(tenant)), opts.onError);
    },
    async stop(): Promise<void> {
      running = false;
      await Promise.all([...runtimes.values()].map((runtime) => runtime.stop()));
    },
  };
}
