import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { recordWebhookTranscript } from "./web-transcript-delivery.ts";
import { createSweeper } from "../util/sweeper.ts";
import { reportFailure } from "../util/errors.ts";

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
  const drain = (): Promise<void> => {
    draining ??= (async () => {
      while (!stopping) {
        const pending = await deliveries.claimPending("webhook", 30_000, 16);
        if (!pending.length) break;
        await Promise.all(
          pending.map(async (delivery) => {
            try {
              if (!(await recordWebhookTranscript(delivery, sessions))) return;
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
                  reportFailure(
                    "webhook response cleanup failed",
                    error,
                    `delivery=${delivery.id} status=${response.status}`,
                  ),
                );
              if (response.status === 410) await deliveries.reject(delivery.id);
              else if (response.ok) await deliveries.ack(delivery.id, Date.now());
              else throw new Error(`Delivery receiver returned HTTP ${response.status}`);
            } catch (error) {
              reportFailure("webhook delivery failed; retained for retry", error, `delivery=${delivery.id}`);
            }
          }),
        );
      }
    })().finally(() => {
      draining = undefined;
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
      unsubscribe?.();
      unsubscribe = undefined;
      await sweeper.stop();
      await draining;
    },
  };
}
