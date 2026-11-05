import { currentTenant, withTenant } from "../tenants/context.ts";
import { createSweeper } from "../util/sweeper.ts";

interface TenantRuntime {
  start(): void;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

export function createTenantSlackRuntimes(opts: {
  runtimeFor: (tenant: string) => TenantRuntime;
  tenants: () => Promise<(string | undefined)[]>;
  onError: (error: unknown) => void;
  discoveryIntervalMs?: number;
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
  const discovery = createSweeper(
    () =>
      opts.tenants().then((tenants) => new Set(tenants).forEach((tenant) => tenant && ensure(tenant)), opts.onError),
    opts.discoveryIntervalMs ?? 5_000,
    { label: "slack tenant discovery", immediate: true },
  );
  return {
    async reconcile(): Promise<void> {
      return ensure(currentTenant()).reconcile();
    },
    start(): void {
      running = true;
      discovery.start();
    },
    async stop(): Promise<void> {
      running = false;
      await discovery.stop();
      await Promise.all([...runtimes.values()].map((runtime) => runtime.stop()));
    },
  };
}
