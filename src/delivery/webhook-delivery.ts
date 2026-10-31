import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { recordWebhookTranscript } from "./web-transcript-delivery.ts";
import { createSweeper } from "../util/sweeper.ts";
import { reportFailure } from "../util/errors.ts";
import type { Delivery } from "../types.ts";

export function createWebhookDeliveryWorker(
  deliveries: DeliveryStore,
  sessions: SessionStore,
  destination: { url: string; secret: string },
  fetcher: typeof fetch = fetch,
) {
  const url = new URL(destination.url);
  let draining: Promise<void> | undefined;
  let stopping = false;
  let unsubscribe: (() => void) | undefined;
  let wake = () => {};
  let requested = false;
  const post = async (delivery: Delivery): Promise<number> => {
    const body = JSON.stringify(delivery);
    const response = await fetcher(url, {
      method: "POST",
      body,
      headers: signedRequestHeaders(destination.secret, "POST", url.pathname + url.search, body, {
        "content-type": "application/json",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body
      ?.cancel()
      .catch((error) =>
        reportFailure("webhook response cleanup failed", error, `delivery=${delivery.id} status=${response.status}`),
      );
    return response.status;
  };
  const deliver = async (delivery: Delivery): Promise<void> => {
    try {
      if (!(await recordWebhookTranscript(delivery, sessions))) return;
      let status = await post(delivery);
      if ([400, 413, 422].includes(status)) {
        reportFailure(
          "webhook payload rejected; sending bounded notice",
          new Error(`Delivery receiver returned HTTP ${status}`),
          `delivery=${delivery.id}`,
        );
        const provenance = delivery.provenance;
        status = await post({
          ...delivery,
          text: "This update exceeds the receiving chat's limits or could not be accepted. Please request a shorter response or fewer files.",
          attachments: undefined,
          provenance: provenance && {
            trigger: provenance.trigger,
            surface: provenance.surface,
            fireKey: provenance.fireKey,
            sourceScopeId: provenance.sourceScopeId,
            sourceThreadRef: provenance.sourceThreadRef,
            ...(provenance.sourceRunId ? { sourceRunId: provenance.sourceRunId } : {}),
            ...(provenance.sourceRequestId ? { sourceRequestId: provenance.sourceRequestId } : {}),
          },
        });
      }
      if ([400, 410, 413, 422].includes(status)) {
        await deliveries.fail(delivery.id, `Delivery receiver returned HTTP ${status}`, Date.now());
      } else if (status >= 200 && status < 300) {
        await deliveries.ack(delivery.id, Date.now());
      } else {
        throw new Error(`Delivery receiver returned HTTP ${status}`);
      }
    } catch (error) {
      reportFailure("webhook delivery failed; retained for retry", error, `delivery=${delivery.id}`);
    }
  };
  const drain = (): Promise<void> => {
    requested = true;
    wake();
    draining ??= (async () => {
      const active = new Set<Promise<void>>();
      try {
        while (!stopping) {
          requested = false;
          const awakened = new Promise<void>((resolve) => {
            wake = resolve;
          });
          const pending = active.size < 16 ? await deliveries.claimPending("webhook", 30_000, 16 - active.size) : [];
          for (const delivery of pending) {
            const work = deliver(delivery).finally(() => {
              active.delete(work);
              requested = true;
              wake();
            });
            active.add(work);
          }
          if (!active.size) {
            if (requested) continue;
            break;
          }
          await Promise.race([...active, awakened]);
        }
      } finally {
        await Promise.all(active);
      }
    })().finally(() => {
      draining = undefined;
      wake = () => {};
    });
    return draining;
  };
  const sweeper = createSweeper(drain, 30_000, { label: "webhook delivery", immediate: true });
  return {
    drain,
    start() {
      stopping = false;
      unsubscribe ??= deliveries.onEnqueue(() => {
        void drain().catch((error) => reportFailure("webhook delivery wake failed", error));
      });
      sweeper.start();
    },
    async stop() {
      stopping = true;
      wake();
      unsubscribe?.();
      unsubscribe = undefined;
      await sweeper.stop();
      await draining;
    },
  };
}
