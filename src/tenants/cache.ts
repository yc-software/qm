import { swallow } from "../util/errors.ts";
import { boundTenant, currentTenant } from "./context.ts";

export function perTenant<V>(create: () => V): () => V {
  const values = new Map<string, V>();
  return () => {
    const id = currentTenant();
    if (values.has(id)) return values.get(id) as V;
    const value = create();
    values.set(id, value);
    return value;
  };
}

export interface TenantListeners<A extends unknown[]> {
  add(listener: (...args: A) => void): () => void;
  emit(...args: A): void;
}

export function tenantListeners<A extends unknown[]>(label: string): TenantListeners<A> {
  const listeners = perTenant(() => new Set<(...args: A) => void>());
  const everyTenant = new Set<(...args: A) => void>();
  return {
    add(listener) {
      const own = boundTenant() === undefined ? everyTenant : listeners();
      own.add(listener);
      return () => own.delete(listener);
    },
    emit(...args) {
      for (const listener of [...listeners(), ...everyTenant]) {
        try {
          listener(...args);
        } catch (e) {
          swallow(`${label} listener`, e);
        }
      }
    },
  };
}

const tenantLoads = new Set<() => Promise<void>>();

export function onTenantLoad(load: () => Promise<unknown>): () => void {
  const runs = perTenant<{ run?: Promise<void> }>(() => ({}));
  const memoized = (): Promise<void> => {
    const state = runs();
    if (state.run) return state.run;
    const run = load().then(() => undefined);
    state.run = run;
    run.catch(() => state.run === run && (state.run = undefined));
    return run;
  };
  tenantLoads.add(memoized);
  return () => tenantLoads.delete(memoized);
}

export function loadTenant(): Promise<void> {
  currentTenant();
  return Promise.all([...tenantLoads].map((load) => load())).then(() => undefined);
}
