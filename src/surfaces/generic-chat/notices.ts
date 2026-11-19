import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { unfinishedTurnText, userFacingFailureClause } from "../../core/failure-copy.ts";
import { reachEnqueue } from "../../reach/reach.ts";
import type { Run } from "../../runs/run-store.ts";
import type { Destination, TurnResult } from "../../types.ts";

import { AWAITING_APPROVAL } from "../approval-cards.ts";
import { drivenLive } from "../turn-flow.ts";
import { GENERIC_CHAT } from "./protocol.ts";

function noticeText(result: Partial<TurnResult>, cards = false): string | undefined {
  if (result.status === "pending_approval")
    return cards && result.pendingApprovals?.length ? undefined : (result.reason ?? AWAITING_APPROVAL);
  if (result.status === "refused" && result.refusalKind !== "approval_denied")
    return unfinishedTurnText(userFacingFailureClause(result));
  return undefined;
}

export function genericChatRunNotice(run: Run): string | undefined {
  if (
    run.request.surface !== GENERIC_CHAT ||
    run.request.origin.kind !== "human" ||
    drivenLive(run.request) ||
    !run.result
  )
    return undefined;
  return noticeText(run.result, run.request.liveReplies === true);
}

const GENERIC_CHAT_GUEST_NOTICE = "I only take requests from the team I work for, so I can't help with this one here.";

export function createGenericChatNotices(deps: { deliveries: DeliveryStore }) {
  return {
    async guest(destination: Destination, idempotencyKey: string): Promise<void> {
      await reachEnqueue({ deliveries: deps.deliveries, destination, text: GENERIC_CHAT_GUEST_NOTICE, idempotencyKey });
    },
    async unanswered(result: Partial<TurnResult>, destination: Destination, idempotencyKey: string): Promise<void> {
      const text = noticeText(result);
      if (text) await reachEnqueue({ deliveries: deps.deliveries, destination, text, idempotencyKey });
    },
  };
}
