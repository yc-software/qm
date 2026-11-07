import type { ActorAssertion, Delivery } from "../types.ts";
import type { Directory } from "./directory.ts";
import {
  FINNY_CLARIFICATION_OTHER_ACTION_ID,
  FINNY_PLAN_ACTION_IDS,
  finnyClarificationCard,
  finnyDecisionCard,
  finnyPlanCard,
  finnyResultCard,
  type FinnyClarificationCardInput,
  type FinnyDecisionCardInput,
  type FinnyPlanCardInput,
  type FinnyResultCardInput,
  type FinnySlackCard,
} from "./finny-cards.ts";
import { postWithVerify, recoveryVerifyOldest, slackReplyArgs } from "./delivery.ts";
import { updateSlackMessage } from "./messaging.ts";
import { parseInteractionBody } from "./payloads.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { isObj } from "../util/objects.ts";

const CLARIFICATION_OPTION_PREFIX = "finny_clarification_option:";
const ACTION_PATTERN = /^finny_(?:plan_|clarification_)/;

export type FinnyPendingApproval =
  | { kind: "plan"; requestId: string; card: Omit<FinnyPlanCardInput, "requestId"> }
  | { kind: "clarification"; requestId: string; card: Omit<FinnyClarificationCardInput, "requestId"> };

export type FinnySlackDecision =
  | { kind: "plan"; action: "approve" | "reject" | "request_change" }
  | { kind: "clarification"; action: "select"; optionId: string }
  | { kind: "clarification"; action: "other" };

export interface FinnyApprovalDecisionInput {
  requestId: string;
  decision: FinnySlackDecision;
  actor: ActorAssertion;
  slack: { channel: string; messageTs: string; threadTs?: string };
}

export type FinnyApprovalOutcome =
  | { kind: "decision"; card: FinnyDecisionCardInput }
  | { kind: "result"; card: FinnyResultCardInput }
  | { kind: "gone" };

export interface FinnyApprovalBridge {
  pending(requestId: string): Promise<FinnyPendingApproval | null>;
  decide(input: FinnyApprovalDecisionInput): Promise<FinnyApprovalOutcome>;
}

function pendingCard(request: FinnyPendingApproval): FinnySlackCard {
  return request.kind === "plan"
    ? finnyPlanCard({ ...request.card, requestId: request.requestId })
    : finnyClarificationCard({ ...request.card, requestId: request.requestId });
}

function outcomeCard(outcome: Exclude<FinnyApprovalOutcome, { kind: "gone" }>): FinnySlackCard {
  return outcome.kind === "decision" ? finnyDecisionCard(outcome.card) : finnyResultCard(outcome.card);
}

export async function deliverFinnyApprovalCard(
  bridge: FinnyApprovalBridge | undefined,
  client: any,
  delivery: Pick<Delivery, "createdAt" | "id" | "idempotencyKey" | "destination">,
  channel: string,
  threadTs: string | undefined,
  recovered: boolean,
): Promise<void> {
  const requestId = delivery.destination.finnyPlanRequestId;
  if (!requestId) return;
  if (!bridge) throw new Error("Finny approval bridge is unavailable");
  const request = await bridge.pending(requestId);
  if (!request) return;
  if (request.requestId !== requestId) throw new Error("Finny approval bridge returned a mismatched request");
  const card = pendingCard(request);
  const verifyOldest = recoveryVerifyOldest(delivery.createdAt, undefined);
  await postWithVerify(
    client,
    { ...slackReplyArgs(channel, card.text, threadTs), blocks: card.blocks },
    delivery.idempotencyKey ?? delivery.id,
    recovered ? { verifyFirst: true, ...(verifyOldest ? { verifyOldest } : {}) } : undefined,
  );
}

function actionDecision(action: unknown): FinnySlackDecision | undefined {
  if (!isObj(action)) return;
  const actionId = typeof action.action_id === "string" ? action.action_id : "";
  if (actionId === FINNY_PLAN_ACTION_IDS.approve) return { kind: "plan", action: "approve" };
  if (actionId === FINNY_PLAN_ACTION_IDS.reject) return { kind: "plan", action: "reject" };
  if (actionId === FINNY_PLAN_ACTION_IDS.requestChange) return { kind: "plan", action: "request_change" };
  if (actionId === FINNY_CLARIFICATION_OTHER_ACTION_ID) return { kind: "clarification", action: "other" };
  if (!actionId.startsWith(CLARIFICATION_OPTION_PREFIX)) return;
  const optionId = actionId.slice(CLARIFICATION_OPTION_PREFIX.length);
  return optionId ? { kind: "clarification", action: "select", optionId } : undefined;
}

export function registerFinnyApprovalActions(
  app: { action(pattern: RegExp, handler: (args: any) => Promise<void>): void },
  deps: { bridge?: FinnyApprovalBridge; directory: Directory },
): void {
  app.action(ACTION_PATTERN, async ({ ack, body, action, client }) => {
    await ack();
    const decision = actionDecision(action);
    const requestId = isObj(action) && typeof action.value === "string" ? action.value : "";
    const { clickerId, channel, messageTs, messageThreadTs } = parseInteractionBody(body);
    if (!decision || !requestId || !clickerId) return;
    const tell = async (text: string): Promise<void> => {
      const sent = channel
        ? await client.chat
            .postEphemeral({ channel, user: clickerId, text })
            .then(() => true)
            .catch(swallowAs("slack: Finny approval notice", false))
        : false;
      if (!sent)
        await client.chat
          .postMessage({ channel: clickerId, text })
          .catch(swallowAs("slack: Finny approval notice dm", undefined));
    };
    if (!deps.bridge) {
      await tell("Finny approvals aren't available right now. Try again shortly.");
      return;
    }
    if (!channel || !messageTs) {
      await tell("Couldn't complete this Finny action from this copy. Try the original card.");
      return;
    }
    try {
      const actor = await deps.directory.classifyActor(client, clickerId);
      const outcome = await deps.bridge.decide({
        requestId,
        decision,
        actor,
        slack: { channel, messageTs, ...(messageThreadTs ? { threadTs: messageThreadTs } : {}) },
      });
      if (outcome.kind === "gone") {
        await tell("This Finny request expired or was already decided.");
        return;
      }
      const card = outcomeCard(outcome);
      await updateSlackMessage(client, channel, messageTs, card.text, card.blocks);
    } catch (error) {
      await tell(`Couldn't complete this Finny action: ${errMessage(error)} Try again.`);
    }
  });
}
