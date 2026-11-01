import { sharedPgBoss } from "../persistence/pg-boss.ts";
import { DELIVERY_MAX_AGE_MS, type DeliveryStore } from "./delivery-store.ts";
import { createSweeper } from "../util/sweeper.ts";
import { reportFailure, swallowAs } from "../util/errors.ts";
import type { Delivery } from "../types.ts";

export interface OutboundChannel {
  type: string;
  send(d: Delivery): Promise<{ refused: string } | void>;
}

const RETRY_DELAY_SECONDS = 5;
const RETRY_DELAY_MAX_SECONDS = 300;

export function createOutboundQueue(
  databaseUrl: string,
  stores: { outbox: DeliveryStore; deliveries: DeliveryStore },
  channels: OutboundChannel[],
) {
  const { outbox, deliveries } = stores;
  const shared = sharedPgBoss(databaseUrl);
  const { boss } = shared;
  const queueOf = (type: string): string => `deliver-${type}`;
  let retained = false;

  const feed = async (): Promise<void> => {
    for (const channel of channels) {
      const ready = new Set((await deliveries.pending(channel.type)).map((d) => d.id));
      const heads = new Map<string, Delivery>();
      for (const d of await outbox.pending(channel.type))
        if (!heads.has(d.destination.target)) heads.set(d.destination.target, d);
      for (const d of heads.values())
        if (ready.has(d.id)) await boss.send(queueOf(channel.type), { id: d.id }, { id: d.id });
    }
  };
  let feeding: Promise<void> | undefined;
  let again = false;
  const wake = (): void => {
    if (!retained) return;
    if (feeding) {
      again = true;
      return;
    }
    feeding = feed()
      .catch((e) => reportFailure("outbound queue: feed failed", e))
      .finally(() => {
        feeding = undefined;
        if (again) {
          again = false;
          wake();
        }
      });
  };
  let unsubscribe: (() => void) | undefined;

  const deliver = async (channel: OutboundChannel, id: string): Promise<void> => {
    const d = await outbox.get(id);
    if (!d || d.deliveredAt !== null || d.expiredAt !== undefined) return;
    const outcome = await channel.send(d).catch((e: unknown) => {
      reportFailure(`outbound queue: ${channel.type} delivery not accepted; pg-boss will retry`, e, `delivery=${id}`);
      throw e;
    });
    if (outcome) await outbox.fail(id, outcome.refused, Date.now());
    else await outbox.ack(id, Date.now());
    wake();
  };

  let stopped = false;
  let booting: Promise<void> | undefined;
  const boot = async (): Promise<void> => {
    await shared.retain();
    if (stopped) return shared.release();
    try {
      for (const channel of channels) {
        await boss.createQueue(queueOf(channel.type), {
          notify: true,
          expireInSeconds: 60,
          retryDelay: RETRY_DELAY_SECONDS,
          retryBackoff: true,
          retryDelayMax: RETRY_DELAY_MAX_SECONDS,
          retryLimit:
            DELIVERY_MAX_AGE_MS / 1000 / RETRY_DELAY_MAX_SECONDS +
            Math.ceil(Math.log2(RETRY_DELAY_MAX_SECONDS / RETRY_DELAY_SECONDS)),
        });
        await boss.work<{ id: string }>(queueOf(channel.type), { batchSize: 1 }, async ([job]) => {
          await deliver(channel, job!.data.id);
        });
      }
    } catch (e) {
      await offWork();
      await shared.release();
      throw e;
    }
    retained = true;
    wake();
  };
  const offWork = async (): Promise<void> => {
    for (const channel of channels)
      await boss
        .offWork(queueOf(channel.type), { wait: false })
        .catch(swallowAs("outbound queue: stop worker", undefined));
  };
  const tick = (): void => {
    if (stopped) return;
    if (retained) return wake();
    booting ??= boot()
      .catch((e) => reportFailure("outbound queue: start failed; retrying on the next sweep", e))
      .finally(() => {
        booting = undefined;
      });
  };
  const sweeper = createSweeper(tick, 60_000, { label: "outbound deliveries", immediate: true });

  return {
    start(): void {
      stopped = false;
      unsubscribe ??= deliveries.onEnqueue(tick);
      sweeper.start();
    },
    async stop(): Promise<void> {
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      await sweeper.stop();
      await booting;
      await feeding;
      if (!retained) return;
      retained = false;
      try {
        await offWork();
      } finally {
        await shared.release();
      }
    },
  };
}
