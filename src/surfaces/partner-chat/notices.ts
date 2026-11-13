import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { unfinishedTurnText, userFacingFailureClause } from "../../core/failure-copy.ts";
import { reachEnqueue } from "../../reach/reach.ts";
import type { Run } from "../../runs/run-store.ts";
import type { Destination, TurnResult } from "../../types.ts";

import { AWAITING_APPROVAL } from "../approval-cards.ts";

function noticeText(result: Partial<TurnResult>): string | undefined {
  if (result.status === "pending_approval")
    return result.pendingApprovals?.length ? undefined : (result.reason ?? AWAITING_APPROVAL);
  if (result.status === "refused" && result.refusalKind !== "approval_denied")
    return unfinishedTurnText(userFacingFailureClause(result));
  return undefined;
}

export function partnerChatRunNotice(run: Run): string | undefined {
  if (run.request.surface !== "partner-chat" || run.request.origin.kind !== "human" || !run.result) return undefined;
  return noticeText(run.result);
}

export function createPartnerChatNotices(deps: { deliveries: DeliveryStore }) {
  return {
    async unanswered(result: Partial<TurnResult>, destination: Destination, idempotencyKey: string): Promise<void> {
      const text = noticeText(result);
      if (text) await reachEnqueue({ deliveries: deps.deliveries, destination, text, idempotencyKey });
    },
  };
}
