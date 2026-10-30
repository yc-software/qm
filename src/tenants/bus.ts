import type { EventBus } from "../util/event-bus.ts";
import { currentTenant, withTenant } from "./context.ts";

export function tenantScopedBus<T extends { tenant?: string }>(inner: EventBus<T>): EventBus<T> {
  return {
    emit: (event) => inner.emit({ ...event, tenant: currentTenant() }),
    subscribe(cb, opts = {}) {
      const { allTenants, onResync } = opts;
      const tenant = allTenants ? undefined : currentTenant();
      return inner.subscribe(
        (event) => {
          if (event.tenant && (tenant === undefined || event.tenant === tenant))
            withTenant(event.tenant, () => cb(event));
        },
        onResync ? { onResync: tenant === undefined ? onResync : () => withTenant(tenant, onResync) } : {},
      );
    },
    ...(inner.close ? { close: () => inner.close!() } : {}),
  };
}
