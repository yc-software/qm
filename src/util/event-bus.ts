import { swallow } from "./errors.ts";
import { boundTenant, isTenantId, withTenant } from "../tenants/context.ts";

export interface SubscribeOptions {
  onResync?: () => void | Promise<void>;
}

type Subscriber<T> = (event: T) => void | Promise<void>;

export interface EventBus<T> {
  emit(event: T): void;
  subscribe(cb: Subscriber<T>, opts?: SubscribeOptions): () => void;
  close?(): Promise<void>;
}

export interface LocalEventBus<T> extends EventBus<T> {
  resync(): void;
  size(): number;
}

function tenantOf(event: unknown): string | undefined {
  const id = typeof event === "object" && event !== null ? (event as { tenantId?: unknown }).tenantId : undefined;
  return isTenantId(id) ? id : undefined;
}

function isolate(context: string, tenant: string | undefined, fn: () => void | Promise<void>): void {
  try {
    const result = tenant ? withTenant(tenant, fn) : fn();
    if (result) result.catch((e: unknown) => swallow(context, e));
  } catch (e) {
    swallow(context, e);
  }
}

export function createMemoryEventBus<T>(label: string): LocalEventBus<T> {
  const listeners = new Set<{ cb: Subscriber<T>; tenant: string | undefined } & SubscribeOptions>();
  return {
    emit(event) {
      const tenant = tenantOf(event);
      for (const sub of listeners) {
        if (sub.tenant && tenant && tenant !== sub.tenant) continue;
        isolate(`${label} listener`, tenant ?? sub.tenant, () => sub.cb(event));
      }
    },
    subscribe(cb, opts = {}) {
      const sub = { cb, tenant: boundTenant(), onResync: opts.onResync };
      listeners.add(sub);
      return () => listeners.delete(sub);
    },
    resync() {
      for (const { tenant, onResync } of listeners) if (onResync) isolate(`${label} resync listener`, tenant, onResync);
    },
    size() {
      return listeners.size;
    },
  };
}
