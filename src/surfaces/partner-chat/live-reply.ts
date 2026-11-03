import type { App } from "../../api/app-types.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue, withEdit } from "../../reach/reach.ts";
import { isTerminal, type RunStore } from "../../runs/run-store.ts";
import type { Destination } from "../../types.ts";
import { reportFailureAs } from "../../util/errors.ts";

const STREAM_INTERVAL_MS = 1_500;
const EDIT_WINDOW_MS = 14 * 60_000;

export const STREAM_KEY_PREFIX = "stream:";

export function createPartnerChatLiveReply(deps: {
  app: Pick<App, "subscribeRun">;
  runs: Pick<RunStore, "get">;
  deliveries: DeliveryStore;
  intervalMs?: number;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;

  function follow(runId: string, destination: Destination): void {
    const began = now();
    let text = "";
    let start = 0;
    let sent = "";
    let edits = 0;
    let busy = false;
    const unsubscribe = deps.app.subscribeRun(runId, (event) => {
      if (event.kind !== "delta") return;
      if (event.startOffset > start) {
        text = text.slice(Math.min(text.length, event.startOffset - start));
        start = event.startOffset;
      }
      const at = event.offset - start;
      if (at >= 0 && at <= text.length) text = text.slice(0, at) + event.text;
    });
    const stop = (): void => {
      clearInterval(timer);
      unsubscribe();
    };
    const tick = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const run = await deps.runs.get(runId);
        const editRef = run?.deliveryState?.editRef;
        if (!run || isTerminal(run.status) || editRef === "" || now() - began > EDIT_WINDOW_MS) return stop();
        const body = text.trim();
        if (!body || body === sent) return;
        if (!sent) {
          await reachEnqueue({ deliveries: deps.deliveries, destination, text: body, idempotencyKey: `ack:${runId}` });
        } else {
          if (!editRef) return;
          await reachEnqueue({
            deliveries: deps.deliveries,
            destination: withEdit(destination, editRef),
            text: body,
            idempotencyKey: `${STREAM_KEY_PREFIX}${runId}:${++edits}`,
          });
        }
        sent = body;
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(
      () => void tick().catch(reportFailureAs("partner-chat: stream reply", undefined)),
      deps.intervalMs ?? STREAM_INTERVAL_MS,
    );
    timer.unref?.();
  }

  return { follow };
}
