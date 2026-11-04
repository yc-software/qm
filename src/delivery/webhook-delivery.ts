import { createHmac } from "node:crypto";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { refusedStatus, type Send } from "./relay.ts";

const SEND_TIMEOUT_MS = 10_000;
export const WEBHOOK_CLAIM_MS = 2 * SEND_TIMEOUT_MS;

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
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return;
    }
    const detail = (await res.text().catch(() => "")).trim().slice(0, 500);
    const reason = `receiver returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
    if (refusedStatus(res.status)) return { refused: reason };
    throw new Error(reason);
  };
}
