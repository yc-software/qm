import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue } from "../../reach/reach.ts";
import type { Run } from "../../runs/run-store.ts";
import type { Destination } from "../../types.ts";
import { reportFailureAs } from "../../util/errors.ts";

const PLACEHOLDER_DELAY_MS = 2_000;
const PLACEHOLDER = "…";
const SETTLED = "✓";

export function createPartnerChatLiveReply(deps: { deliveries: DeliveryStore; delayMs?: number }) {
  const enqueue = (destination: Destination, text: string, idempotencyKey: string) =>
    reachEnqueue({ deliveries: deps.deliveries, destination, text, idempotencyKey }).catch(
      reportFailureAs("partner-chat: live reply", undefined),
    );

  return {
    follow(runId: string, destination: Destination): void {
      const timer = setTimeout(
        () => void enqueue(destination, PLACEHOLDER, `placeholder:${runId}`),
        deps.delayMs ?? PLACEHOLDER_DELAY_MS,
      );
      timer.unref?.();
    },
    settle(run: Run): void {
      const target = run.request.deliveryTarget;
      if (run.request.surface !== "partner-chat" || run.request.origin.kind !== "human" || !target) return;
      if (run.deliveryState?.editRef === "") return;
      void enqueue({ type: "partner-chat", target }, SETTLED, `settle:${run.id}`);
    },
  };
}
