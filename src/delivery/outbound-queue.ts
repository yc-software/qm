import { PgBoss } from "pg-boss";
import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { DELIVERY_MAX_AGE_MS, type DeliveryStore } from "./delivery-store.ts";
import { createSweeper } from "../util/sweeper.ts";
import { reportFailure } from "../util/errors.ts";
import type { Delivery } from "../types.ts";

export interface OutboundChannel {
  type: string;
  send(d: Delivery): Promise<{ refused: string } | void>;
}

const RETRY_DELAY_SECONDS = 5;

export function createOutboundQueue(databaseUrl: string, deliveries: DeliveryStore, channels: OutboundChannel[]) {
  let pg: PgPool | null = null;
  const boss = new PgBoss({
    schema: "pgboss",
    db: {
      executeSql: async (text, values) => {
        if (!pg) throw new Error("Outbound queue database is closed");
        return (await pg.pool()).query(text, values);
      },
    },
  });
  boss.on("error", (e) => reportFailure("outbound queue: pg-boss error", e));
  const queueOf = (type: string): string => `deliver-${type}`;

  const feed = async (): Promise<void> => {
    for (const channel of channels) {
      const heads = new Map<string, Delivery>();
      for (const d of await deliveries.pending(channel.type))
        if (!heads.has(d.destination.target)) heads.set(d.destination.target, d);
      for (const d of heads.values()) await boss.send(queueOf(channel.type), { id: d.id }, { id: d.id });
    }
  };
  let feeding: Promise<void> | undefined;
  let again = false;
  const wake = (): void => {
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
  const sweeper = createSweeper(wake, 60_000, { label: "outbound deliveries" });
  let unsubscribe: (() => void) | undefined;

  const deliver = async (channel: OutboundChannel, id: string): Promise<void> => {
    const d = await deliveries.get(id);
    if (!d || d.deliveredAt !== null || d.expiredAt !== undefined) return;
    const outcome = await channel.send(d);
    if (outcome) await deliveries.fail(id, outcome.refused, Date.now());
    else await deliveries.ack(id, Date.now());
    wake();
  };

  return {
    async start(): Promise<void> {
      pg ??= createPgPool(databaseUrl);
      await boss.start();
      for (const channel of channels) {
        await boss.createQueue(queueOf(channel.type), {
          notify: true,
          retryDelay: RETRY_DELAY_SECONDS,
          retryBackoff: true,
          retryDelayMax: 300,
          retryLimit: DELIVERY_MAX_AGE_MS / 1000 / RETRY_DELAY_SECONDS,
        });
        await boss.work<{ id: string }>(queueOf(channel.type), { batchSize: 1 }, async ([job]) => {
          await deliver(channel, job!.data.id);
        });
      }
      unsubscribe = deliveries.onEnqueue(wake);
      sweeper.start();
      wake();
    },
    async stop(): Promise<void> {
      unsubscribe?.();
      unsubscribe = undefined;
      await sweeper.stop();
      await feeding;
      try {
        await boss.stop({ close: true, graceful: false });
      } finally {
        const previous = pg;
        pg = null;
        await previous?.close();
      }
    },
  };
}
