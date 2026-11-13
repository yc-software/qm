import type { DeliveryStore } from "./delivery-store.ts";
import { createSweeper } from "../util/sweeper.ts";
import { reportFailure } from "../util/errors.ts";
import type { Delivery } from "../types.ts";
import { type Tenant, withTenant } from "../tenants/context.ts";

export type Send = (d: Delivery, tenant: Tenant) => Promise<{ refused: string } | void>;

const RETRY_CAP_MS = 30 * 60_000;

export function refusedStatus(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

export function createDeliveryRelay(
  deliveries: DeliveryStore,
  { type, send, claimMs }: { type: string; send: Send; claimMs: number },
) {
  let stopped = true;
  const inFlight = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };
  const deliver = async (d: Delivery, tenant: Tenant): Promise<void> => {
    let outcome: { refused: string } | void;
    try {
      outcome = await send(d, tenant);
    } catch (e) {
      const delayMs = Math.min(Math.max(claimMs, Date.now() - d.createdAt), RETRY_CAP_MS);
      reportFailure(
        `${type} delivery: not accepted; retrying once its claim lapses`,
        e,
        `delivery=${d.id} retry_in=${Math.round(delayMs / 1000)}s`,
      );
      await deliveries.retryAfter(tenant, d.id, delayMs);
      return;
    }
    if (outcome) await deliveries.fail(d.id, outcome.refused, Date.now());
    else await deliveries.ack(d.id, Date.now());
    pass();
  };
  const pass = (): void => {
    if (stopped) return;
    track(
      deliveries
        .claimDue(type, claimMs)
        .then((rows) => {
          for (const d of rows)
            track(
              withTenant(d.tenantId, (tenant) => deliver(d, tenant)).catch((e) =>
                reportFailure(`${type} delivery failed`, e),
              ),
            );
        })
        .catch((e) => reportFailure(`${type} delivery: claim failed`, e)),
    );
  };
  const sweeper = createSweeper(pass, claimMs / 4, { label: `${type} deliveries`, immediate: true });
  let unsubscribe: (() => void) | undefined;
  return {
    start(): void {
      stopped = false;
      unsubscribe ??= deliveries.onEnqueue((enqueued) => {
        if (enqueued === type) pass();
      });
      sweeper.start();
    },
    async stop(): Promise<void> {
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      await sweeper.stop();
      while (inFlight.size) await Promise.allSettled(inFlight);
    },
  };
}
