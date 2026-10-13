import { UNSETTLED, type CronFireStore } from "./fire-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { Delivery, TurnResult } from "../types.ts";
import { cronIdOf } from "../sessions/session-store.ts";
import { reportFailureAs } from "../util/errors.ts";

export async function settleCronFire(
  fires: Pick<CronFireStore, "listByThreadRefs" | "record">,
  delivery: Delivery | null,
  status: Extract<TurnResult["status"], "ok" | "failed">,
  at: number,
  note?: string,
): Promise<void> {
  const provenance = delivery?.provenance;
  if (!provenance || provenance.trigger !== "cron") return;
  const cronId = cronIdOf(provenance.sourceThreadRef);
  if (!cronId) return;
  const fire = (await fires.listByThreadRefs([provenance.sourceThreadRef])).find(
    (f) => f.cronId === cronId && f.fireKey === provenance.fireKey && UNSETTLED.has(f.status),
  );
  if (!fire) return;
  const { cronId: _cronId, ...entry } = fire;
  await fires.record(cronId, { ...entry, status, endedAt: at, ...(note ? { note } : {}) });
}

export function withCronFireSettlement(
  store: DeliveryStore,
  fires: Pick<CronFireStore, "listByThreadRefs" | "record">,
): DeliveryStore {
  return {
    ...store,
    async ack(id, at, slackApiMs) {
      await store.ack(id, at, slackApiMs);
      await settleCronFire(fires, await store.get(id), "ok", at).catch(
        reportFailureAs("delivery: settle cron fire", undefined, `delivery=${id}`),
      );
    },
  };
}
