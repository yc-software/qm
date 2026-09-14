import { createSendTiming, logSendTiming, type SendTimingStage } from "../../chassis/src/send-timing.ts";

export function beginSendTiming(endpoint: string) {
  const traceId = crypto.randomUUID();
  const seen = new Set<SendTimingStage>();
  const record = createSendTiming(traceId, "browser", (event) => {
    logSendTiming(event);
    void fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      keepalive: true,
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
  });
  const mark = (stage: SendTimingStage): void => {
    if (seen.has(stage)) return;
    seen.add(stage);
    record(stage);
  };
  mark("send_start");
  return {
    traceId,
    mark,
    onRendered(element: Element | undefined): void {
      if (!element || seen.has("queue_rendered")) return;
      requestAnimationFrame(() => {
        if (element.isConnected && element.getClientRects().length) mark("queue_rendered");
      });
    },
  };
}
export type SendTiming = ReturnType<typeof beginSendTiming>;
