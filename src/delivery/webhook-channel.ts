import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import type { OutboundChannel } from "./relay.ts";

export function webhookChannel(signingSecret: string, fetcher: typeof fetch = fetch): OutboundChannel {
  return {
    type: "webhook",
    async send(d) {
      const url = new URL(d.destination.webhook!.url);
      const body = JSON.stringify(d);
      const res = await fetcher(url, {
        method: "POST",
        body,
        headers: signedRequestHeaders(signingSecret, "POST", url.pathname + url.search, body, {
          "content-type": "application/json",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return;
      const status = `receiver returned HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return { refused: status };
      throw new Error(status);
    },
  };
}
