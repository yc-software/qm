import { swallow } from "./errors.ts";

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
      listeners.set(cb, opts);
      return () => listeners.delete(cb);
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
