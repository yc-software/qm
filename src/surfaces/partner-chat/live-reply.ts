import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { unfinishedTurnText, userFacingFailureClause } from "../../core/failure-copy.ts";
import { reachEnqueue } from "../../reach/reach.ts";
import type { Run } from "../../runs/run-store.ts";
import type { Destination, TurnResult } from "../../types.ts";
import { reportFailureAs } from "../../util/errors.ts";

const AWAITING_APPROVAL = "This conversation is waiting on a pending approval.";

export function createPartnerChatLiveReply(deps: { deliveries: DeliveryStore }) {
  function unanswered(result: Partial<TurnResult>, destination: Destination, idempotencyKey: string): void {
    let text: string | undefined;
    if (result.status === "pending_approval") text = result.reason ?? AWAITING_APPROVAL;
    else if (result.status === "refused") text = unfinishedTurnText(userFacingFailureClause(result));
    if (text)
      void reachEnqueue({ deliveries: deps.deliveries, destination, text, idempotencyKey }).catch(
        reportFailureAs("partner-chat: notice", undefined),
      );
  }
  return {
    settle(run: Run): void {
      const target = run.request.deliveryTarget;
      if (run.request.surface !== "partner-chat" || run.request.origin.kind !== "human" || !target || !run.result)
        return;
      unanswered(run.result, { type: "partner-chat", target }, `notice:${run.id}`);
    },
    unanswered,
  };
}
