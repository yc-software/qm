import type { DeliveryStore } from "./delivery-store.ts";
import { createSweeper } from "../util/sweeper.ts";
import { errMessage, reportFailure } from "../util/errors.ts";
import type { Delivery } from "../types.ts";
import { type Tenant, withTenant } from "../tenants/context.ts";

export type Send = (d: Delivery, tenant: Tenant) => Promise<{ refused: string } | void>;

const RETRY_CAP_MS = 30 * 60_000;
const AUTH_REFUSAL_ATTEMPTS = 5;

export class DeliveryHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function refusedStatus(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

const unauthorized = (e: unknown): boolean => e instanceof DeliveryHttpError && [401, 403].includes(e.status);

export function createDeliveryRelay(
  deliveries: DeliveryStore,
  { type, send, claimMs }: { type: string; send: Send; claimMs: number },
) {
  let stopped = true;
  const inFlight = new Set<Promise<void>>();
  const failures = new Map<string, { attempts: number; unauthorized: number; retryAt: number }>();
  const track = (work: Promise<void>): void => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };
  const deliver = async (d: Delivery, tenant: Tenant): Promise<void> => {
    const prior = failures.get(d.id);
    if (prior && prior.retryAt > Date.now()) return;
    const outcome = await send(d, tenant).catch((e: unknown) => {
      const attempts = (prior?.attempts ?? 0) + 1;
      const auth = unauthorized(e) ? (prior?.unauthorized ?? 0) + 1 : 0;
      if (auth >= AUTH_REFUSAL_ATTEMPTS) return { refused: `${errMessage(e)} (${auth} times in a row)` };
      const retryAt = Date.now() + Math.min(claimMs * 2 ** (attempts - 1), RETRY_CAP_MS);
      failures.set(d.id, { attempts, unauthorized: auth, retryAt });
      if ((attempts & (attempts - 1)) === 0)
        reportFailure(
          `${type} delivery: not accepted; retrying with backoff`,
          e,
          `delivery=${d.id} attempt=${attempts}`,
        );
      return null;
    });
    if (outcome === null) return;
    failures.delete(d.id);
    if (outcome) await deliveries.fail(d.id, outcome.refused, Date.now());
    else await deliveries.ack(d.id, Date.now());
    pass();
  };
  const pass = (): void => {
    if (stopped) return;
    for (const [id, f] of failures) if (f.retryAt < Date.now() - RETRY_CAP_MS) failures.delete(id);
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
