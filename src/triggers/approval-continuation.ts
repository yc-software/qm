import type { DurableMap } from "../persistence/durable-map.ts";
import type { PendingApprovalRecord, TurnRequest, TurnResult } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { reportFailureAs } from "../util/errors.ts";
import { runTrigger, type TriggerDeps } from "./run-trigger.ts";

export const APPROVAL_SURFACE = "approval";

export type ApprovalContinuation = (
  decision: NonNullable<TurnRequest["approval"]>,
  actorId: string,
) => Promise<TurnResult>;

export function createApprovalContinuation(
  deps: TriggerDeps & { approvals: Pick<DurableMap<PendingApprovalRecord>, "get"> },
): ApprovalContinuation {
  return async (decision, actorId) => {
    const request = (await deps.approvals.get(decision.requestId))?.request;
    if (!request || !samePerson(request.actor.externalId, actorId))
      return { status: "refused", reason: "that approval request expired — ask again if you still want it to run" };
    const origin = request.origin?.kind === "automation" ? request.origin : undefined;
    void runTrigger(deps, {
      owner: request.actor.externalId,
      ownerScopeId: conversationScope(request.conversation, request.actor.externalId),
      input: request.text,
      fireKey: `approval:${decision.requestId}:${decision.approved}`,
      surface: APPROVAL_SURFACE,
      threadRef: request.conversation.threadRef,
      approval: decision,
      ...(origin?.destination ? { destination: origin.destination } : {}),
      ...(request.botActor ? { botActor: true } : {}),
    }).catch(reportFailureAs("approval continuation", undefined, decision.requestId));
    return { status: "queued" };
  };
}
