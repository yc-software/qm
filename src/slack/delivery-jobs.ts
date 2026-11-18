import type { Job } from "pg-boss";
import { poolBoss } from "../cron/job-queue.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { queryPoolSize, type PgPool } from "../persistence/pg-pool.ts";
import { inTenant } from "../tenants/claim.ts";
import { type Tenant, withoutTenant } from "../tenants/context.ts";
import type { Delivery } from "../types.ts";
import { errorAlreadyReported, reportFailure, reportFailureAs, swallowAs } from "../util/errors.ts";
import { slackRetryAfterMs } from "./delivery.ts";

export const SLACK_DELIVERY_CLAIM_MS = 15_000;
const SLACK_DELIVERY_TYPES = ["slack", "group", "principal"];
const QUEUE = "slack-delivery";
const SWEEP = "slack-delivery-sweep";

export type DeliveryLane = (d: Delivery) => Promise<void>;
export type SlackDeliveryJobs = ReturnType<typeof createSlackDeliveryJobs>;

interface Conversation {
  tenantId: string;
  type: string;
  target: string;
}

export function createSlackDeliveryJobs(
  pg: PgPool,
  store: Pick<DeliveryStore, "claimHead" | "defer" | "pendingHeads" | "onEnqueue">,
  claimMs = SLACK_DELIVERY_CLAIM_MS,
) {
  const lanes = new Map<string, Set<DeliveryLane>>();
  let running: Promise<() => Promise<void>> | undefined;

  const drain = async (tenant: Tenant, c: Conversation): Promise<number | undefined> => {
    const [lane] = lanes.get(c.tenantId) ?? [];
    if (!lane) return Date.now() + claimMs;
    for (;;) {
      const head = await store.claimHead(tenant, c.type, c.target, claimMs);
      if (!head) return undefined;
      if (head.heldUntil) return head.heldUntil;
      try {
        await lane(head.delivery);
      } catch (e) {
        const retryMs = slackRetryAfterMs(e);
        if (retryMs === undefined) {
          reportFailure(
            "slack delivery: not delivered; retrying once its claim lapses",
            e,
            `delivery=${head.delivery.id}`,
          );
          throw e;
        }
        const until = Date.now() + retryMs;
        await store.defer(tenant, head.delivery.id, until);
        return until;
      }
    }
  };

  const start = async (): Promise<() => Promise<void>> => {
    const boss = poolBoss(() => pg, { migrate: false, superviseIntervalSeconds: 10, monitorIntervalSeconds: 10 });
    boss.on("error", (e) => reportFailure("slack delivery jobs", e));
    const workers: string[] = [];
    let next = 0;
    const send = (c: Conversation, startAfter?: number): Promise<string | null> => {
      const key = `${c.tenantId}:${c.type}:${c.target}`;
      return boss.send(QUEUE, c, {
        singletonKey: key,
        group: { id: key },
        ...(startAfter ? { startAfter: new Date(startAfter) } : {}),
      });
    };
    const wake = (): void => {
      if (workers.length) boss.notifyWorker(workers[next++ % workers.length]!);
    };
    const enqueue = async (c: Conversation, startAfter?: number): Promise<void> => {
      await send(c, startAfter);
      if (startAfter) setTimeout(() => workers.forEach(wake), startAfter - Date.now() + 1_000).unref();
      else wake();
    };
    const deliver = async ([job]: Job<Conversation>[]): Promise<void> => {
      const c = job!.data;
      try {
        const until = await inTenant(c.tenantId, (tenant) => drain(tenant, c));
        if (until) await enqueue(c, until);
        wake();
      } catch (e) {
        if (!errorAlreadyReported(e))
          reportFailure("slack delivery job failed", e, `${c.tenantId} ${c.type} ${c.target}`);
        throw e;
      }
    };
    const sweep = async (): Promise<void> => {
      const heads = await store.pendingHeads(SLACK_DELIVERY_TYPES);
      if (!heads.length) return;
      await Promise.all(heads.map((c) => send(c)));
      workers.forEach(wake);
    };
    let unsubscribe = (): void => {};
    try {
      await boss.start();
      await boss.createQueue(QUEUE, { policy: "short", retryDelay: Math.ceil(claimMs / 1000), heartbeatSeconds: 10 });
      await boss.createQueue(SWEEP, { policy: "short" });
      await boss.schedule(SWEEP, "* * * * *");
      for (let i = 0; i < Math.ceil(queryPoolSize() / 2); i++)
        workers.push(
          await boss.work<Conversation>(QUEUE, { pollingIntervalSeconds: 10, groupConcurrency: 1 }, deliver),
        );
      unsubscribe = store.onEnqueue((type, target, tenantId) => {
        if (SLACK_DELIVERY_TYPES.includes(type))
          void enqueue({ tenantId, type, target }).catch((e: unknown) =>
            reportFailure("slack delivery: not queued; the next sweep queues it", e, `${tenantId} ${type} ${target}`),
          );
      });
      const sweeper = await boss.work(SWEEP, { pollingIntervalSeconds: 30 }, () =>
        sweep().catch(reportFailureAs("slack delivery sweep", undefined)),
      );
      await boss.send(SWEEP, null);
      boss.notifyWorker(sweeper);
    } catch (e) {
      unsubscribe();
      await boss.stop({ graceful: false }).catch(swallowAs("slack delivery jobs: stop after failed start", undefined));
      throw e;
    }
    return async () => {
      unsubscribe();
      await boss.stop({ timeout: claimMs });
    };
  };

  const ensureRunning = (): void => {
    if (running || !lanes.size) return;
    const started = withoutTenant(start);
    running = started;
    started.catch((e: unknown) => {
      reportFailure("slack delivery jobs: start failed", e);
      running = undefined;
      setTimeout(ensureRunning, claimMs).unref();
    });
  };

  return {
    serve(tenantId: string, lane: DeliveryLane): () => void {
      lanes.set(tenantId, (lanes.get(tenantId) ?? new Set()).add(lane));
      ensureRunning();
      return () => {
        lanes.get(tenantId)?.delete(lane);
        if (!lanes.get(tenantId)?.size) lanes.delete(tenantId);
        if (lanes.size || !running) return;
        const stopping = running;
        running = undefined;
        void stopping.then((stop) => stop()).catch(swallowAs("slack delivery jobs: stop", undefined));
      };
    },
  };
}
