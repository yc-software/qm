import { swallow } from "../util/errors.ts";
import { currentTenant } from "./context.ts";

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
  return {
    add(listener) {
      const own = listeners();
      own.add(listener);
      return () => own.delete(listener);
    },
    emit(...args) {
      for (const listener of listeners()) {
        try {
          listener(...args);
        } catch (e) {
          swallow(`${label} listener`, e);
        }
      }
    },
  };
}

export function tenantLoader(loaders: ReadonlyArray<() => Promise<unknown>>): () => Promise<void> {
  const loads = perTenant<{ run?: Promise<void> }>(() => ({}));
  return () => {
    const state = loads();
    if (state.run) return state.run;
    const run = Promise.all(loaders.map((loader) => loader())).then(() => undefined);
    state.run = run;
    run.catch(() => state.run === run && (state.run = undefined));
    return run;
  };
}
