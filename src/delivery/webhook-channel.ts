import { createHmac } from "node:crypto";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import type { OutboundChannel } from "./outbound-queue.ts";

export function webhookSigningKey(signingSecret: string): string {
  return createHmac("sha256", signingSecret).update("delivery-webhook").digest("hex");
}

export function webhookChannel(signingSecret: string, fetcher: typeof fetch = fetch): OutboundChannel {
  const key = webhookSigningKey(signingSecret);
  return {
    type: "webhook",
    async send(d) {
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
    },
  };
}
