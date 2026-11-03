import type { EventBus } from "../util/event-bus.ts";
import { reportFailureAs } from "../util/errors.ts";
import { boundTenant, currentTenant, withTenant } from "./context.ts";

export function tenantScopedBus<T extends { tenant?: string }>(inner: EventBus<T>): EventBus<T> {
  return {
    emit(event) {
      const tenant = boundTenant();
      if (tenant) inner.emit({ ...event, tenant });
      else console.error("[event-bus] dropped an event emitted with no tenant bound");
    },
    subscribe(cb, opts = {}) {
      const { allTenants, onResync } = opts;
      const tenant = allTenants ? undefined : currentTenant();
      return inner.subscribe(
        (event) => {
          if (event.tenant && (tenant === undefined || event.tenant === tenant))
            withTenant(event.tenant, () => cb(event)).catch(reportFailureAs("event-bus: deliver", undefined));
        },
        onResync
          ? {
              onResync:
                tenant === undefined
                  ? onResync
                  : () => void withTenant(tenant, onResync).catch(reportFailureAs("event-bus: resync", undefined)),
            }
          : {},
      );
    },
    ...(inner.close ? { close: () => inner.close!() } : {}),
  };
}
