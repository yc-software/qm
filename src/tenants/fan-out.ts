import type { JobWorker } from "../jobs/job-worker.ts";
import { tenant, withTenant, type Tenant } from "../tenant.ts";
import type { TurnRunner } from "../turns/turn-runner.ts";
import { reportFailure } from "../util/errors.ts";
import { activeTenants, watchActiveTenants } from "./directory.ts";

interface Live<T> {
  tenant: Tenant;
  item: T;
  started: boolean;
}

function perActiveTenant<T>(
  create: () => T,
  start: (item: T) => unknown,
  retire: (item: T) => Promise<unknown>,
  drained: (item: T) => boolean = () => true,
) {
  const live = new Map<string, Live<T>>();
  const retiring = new Set<Live<T>>();
  let running = false;
  let watching = false;
  const launch = (entry: Live<T>) => {
    entry.started = true;
    void Promise.resolve(withTenant(entry.tenant, () => start(entry.item))).catch((error: unknown) => {
      entry.started = false;
      reportFailure(`tenant ${entry.tenant.slug ?? "home"}: background start`, error);
    });
  };
  const ensure = (t: Tenant): T => {
    const key = t.id ?? "";
    let entry = live.get(key);
    if (!entry) {
      entry = { tenant: t, item: withTenant(t, create), started: false };
      live.set(key, entry);
    }
    if (running && !entry.started) launch(entry);
    return entry.item;
  };
  const sync = (active: Tenant[]) => {
    for (const entry of retiring) if (drained(entry.item)) retiring.delete(entry);
    if (!running) return;
    const keep = new Set(active.map((t) => t.id ?? ""));
    for (const t of active) ensure(t);
    for (const [key, entry] of live) {
      if (keep.has(key)) continue;
      live.delete(key);
      retiring.add(entry);
      void withTenant(entry.tenant, () => retire(entry.item)).catch((error: unknown) =>
        reportFailure(`tenant ${entry.tenant.slug ?? key}: background stop`, error),
      );
    }
  };
  const entries = () => [...live.values(), ...retiring];
  return {
    current: () => ensure(tenant()),
    items: () => entries().map((entry) => entry.item),
    async start() {
      running = true;
      if (!watching) watchActiveTenants(sync);
      watching = true;
      for (const entry of live.values()) if (!entry.started) launch(entry);
      sync(await activeTenants());
    },
    halt() {
      running = false;
      for (const entry of live.values()) entry.started = false;
      return entries();
    },
  };
}

export function tenantJobWorkers(create: () => JobWorker): JobWorker {
  const registrations: Array<(worker: JobWorker) => void> = [];
  const tenants = perActiveTenant(
    () => {
      const worker = create();
      for (const register of registrations) register(worker);
      return worker;
    },
    (worker) => worker.start(),
    (worker) => worker.stop(),
  );
  const register = (apply: (worker: JobWorker) => void) => {
    registrations.push(apply);
    for (const worker of tenants.items()) apply(worker);
  };
  const each = async (fn: (entry: Live<JobWorker>) => Promise<void>) => {
    await Promise.all(tenants.halt().map((entry) => withTenant(entry.tenant, () => fn(entry))));
  };
  return {
    handle: (name, handler, opts) => register((worker) => worker.handle(name, handler, opts)),
    every: (name, everyMs, fn, opts) => register((worker) => worker.every(name, everyMs, fn, opts)),
    spawn: (name, params, key) => tenants.current().spawn(name, params, key),
    start: () => tenants.start(),
    healthy: () => tenants.items().length > 0 && tenants.items().every((worker) => worker.healthy()),
    stopClaims: () => each((entry) => entry.item.stopClaims()),
    stop: () => each((entry) => entry.item.stop()),
  };
}

export function tenantTurnRunners(create: () => TurnRunner): TurnRunner {
  const tenants = perActiveTenant(
    create,
    (runner) => runner.start(),
    (runner) => runner.stopClaims(),
    (runner) => runner.held().length === 0,
  );
  const each = async (fn: (runner: TurnRunner) => Promise<void>) => {
    await Promise.all(tenants.halt().map((entry) => withTenant(entry.tenant, () => fn(entry.item))));
  };
  return {
    start: () => void tenants.start().catch((error: unknown) => reportFailure("turns: start tenant runners", error)),
    stopClaims: () => each((runner) => runner.stopClaims()),
    releaseInFlight: () => each((runner) => runner.releaseInFlight()),
    held: () => tenants.items().flatMap((runner) => runner.held()),
  };
}
