import type { OutboundPort } from "./types.ts";

const GROK_WEBHOOK_TIMEOUT_MS = 10_000;

export function createHttpOutbound(fetchImpl: typeof fetch = fetch): OutboundPort {
  return {
    async postJob(url, bearer, envelope) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(GROK_WEBHOOK_TIMEOUT_MS),
        });
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false, status: 0 };
      }
    },
  };
}
