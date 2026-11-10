import { swallow } from "./errors.ts";
import { boundTenant, withTenant } from "../tenants/context.ts";

export interface SubscribeOptions {
  onResync?: () => void;
}

export interface EventBus<T> {
  emit(event: T): void;
  subscribe(cb: (event: T) => void, opts?: SubscribeOptions): () => void;
  close?(): Promise<void>;
}

export interface LocalEventBus<T> extends EventBus<T> {
  resync(): void;
  size(): number;
}

export function createMemoryEventBus<T>(label: string): LocalEventBus<T> {
  const listeners = new Map<(e: T) => void, SubscribeOptions>();
  return {
    emit(event) {
      for (const cb of listeners.keys()) {
        try {
          cb(event);
        } catch (e) {
          swallow(`${label} listener`, e);
        }
      }
    },
    subscribe(cb, opts = {}) {
      const tenant = boundTenant();
      if (!tenant) {
        listeners.set(cb, opts);
        return () => listeners.delete(cb);
      }
      const bound = (event: T): void => withTenant(tenant, () => cb(event));
      const onResync = opts.onResync;
      listeners.set(bound, onResync ? { onResync: () => withTenant(tenant, onResync) } : {});
      return () => listeners.delete(bound);
    },
    resync() {
      for (const { onResync } of listeners.values()) {
        try {
          onResync?.();
        } catch (e) {
          swallow(`${label} resync listener`, e);
        }
      }
    },
    size() {
      return listeners.size;
    },
  };
}
