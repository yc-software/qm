import { createHmac } from "node:crypto";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import { createSweeper } from "../util/sweeper.ts";
import { reportFailure } from "../util/errors.ts";
import type { Delivery } from "../types.ts";

type Send = (d: Delivery) => Promise<{ refused: string } | void>;

const CLAIM_MS = 20_000;

export function webhookSigningKey(signingSecret: string): string {
  return createHmac("sha256", signingSecret).update("delivery-webhook").digest("hex");
}

export function webhookSender(signingSecret: string | undefined, fetcher: typeof fetch = fetch): Send {
  const key = signingSecret && webhookSigningKey(signingSecret);
  return async (d) => {
    if (!key) return { refused: "core has no CORE_SIGNING_SECRET to sign webhook deliveries with" };
    const url = new URL(d.destination.webhook!.url);
    const body = JSON.stringify(d);
    const res = await fetcher(url, {
      method: "POST",
      body,
      headers: signedRequestHeaders(key, "POST", url.pathname + url.search, body, {
        "content-type": "application/json",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return;
    }
    const detail = (await res.text().catch(() => "")).trim().slice(0, 500);
    const reason = `receiver returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return { refused: reason };
    throw new Error(reason);
  };
}

export function createWebhookDelivery(deliveries: DeliveryStore, send: Send) {
  let stopped = true;
  const inFlight = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };
  const deliver = async (d: Delivery): Promise<void> => {
    const outcome = await send(d).catch((e: unknown) => {
      reportFailure("webhook delivery: not accepted; retrying once its claim lapses", e, `delivery=${d.id}`);
      return null;
    });
    if (outcome === null) return;
    if (outcome) await deliveries.fail(d.id, outcome.refused, Date.now());
    else await deliveries.ack(d.id, Date.now());
    pass();
  };
  const pass = (): void => {
    if (stopped) return;
    track(
      deliveries
        .claimPending("webhook", CLAIM_MS, { oldestPerConversation: true })
        .then((rows) => {
          for (const d of rows) track(deliver(d).catch((e) => reportFailure("webhook delivery failed", e)));
        })
        .catch((e) => reportFailure("webhook delivery: claim failed", e)),
    );
  };
  const sweeper = createSweeper(pass, CLAIM_MS / 4, { label: "webhook deliveries", immediate: true });
  let unsubscribe: (() => void) | undefined;
  return {
    start(): void {
      stopped = false;
      unsubscribe ??= deliveries.onEnqueue(pass);
      sweeper.start();
    },
    async stop(): Promise<void> {
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      await sweeper.stop();
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
  };
}
