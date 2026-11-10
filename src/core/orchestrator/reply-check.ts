import type { AgentTurnResult } from "../../agent/agent.ts";
import type { ReplyCheckFactory } from "../../decisions/hooks.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue } from "../../reach/reach.ts";
import { forModelContext } from "../../agent/context-compaction.ts";
import type { Item } from "../../sessions/items.ts";
import { enqueueDirectReply, type createSurfaceToolDeps, type SpineState } from "../../surfaces/surface-tools.ts";
import type { DeliveryProvenance, Destination, Session } from "../../types.ts";
import { errMessage, reportFailure, swallowAs } from "../../util/errors.ts";
import type { materializeInbound } from "../attachments.ts";
import { spokenByPerson } from "../turn-origin.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";
import { stripAckPrefix, type TurnPostKeys } from "./turn-helpers.ts";

export interface InterimReplyContext {
  surfaceName: string;
  spineTurn: boolean;
  addressed: boolean;
  strictReadOnly: boolean;
  destination: Destination | undefined;
  deliveries: DeliveryStore;
  postKeys: TurnPostKeys;
  provenance: (key: string) => DeliveryProvenance;
  ackText: () => string | undefined;
  postedSoFar: () => number;
}

export function interimReplyDelivery(ctx: InterimReplyContext): (text: string) => Promise<boolean> {
  return async (text) => {
    if (ctx.surfaceName === "web") return true;
    if (ctx.strictReadOnly || !ctx.destination) return false;
    if (ctx.spineTurn && (!ctx.addressed || ctx.postedSoFar() > 0)) return false;
    const interim = stripAckPrefix(text, ctx.ackText()).trim();
    if (!interim) return false;
    const key = `${ctx.postKeys.key(ctx.destination, 0)}:interim`;
    await reachEnqueue({
      deliveries: ctx.deliveries,
      destination: ctx.destination,
      text: interim,
      idempotencyKey: key,
      provenance: ctx.provenance(key),
    });
    return true;
  };
}

export function turnGuidance(
  soul: string | undefined,
  channelOrders: (() => Promise<string | undefined>) | undefined,
): () => Promise<string> {
  return async () => {
    const orders = (await channelOrders?.()) ?? "";
    return [soul ?? "", orders].filter((text) => text.trim()).join("\n\n");
  };
}

type InboundImages = Awaited<ReturnType<typeof materializeInbound>>["images"];

interface AddressedReplyTurn<R extends AgentTurnResult> {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  session: Session;
  strictReadOnly: boolean;
  sessionTurn: boolean;
  surfaceToolDeps: ReturnType<typeof createSurfaceToolDeps>;
  spine: SpineState;
  ackText: () => string | undefined;
  defaultDestination: Destination | undefined;
  postKeys: TurnPostKeys;
  postProvenance: (key: string) => DeliveryProvenance;
  isPollFire: boolean;
  surfaceName: string;
  inbound: { images: InboundImages };
  replyCheck: Awaited<ReturnType<ReplyCheckFactory>>;
  filterHistory: (items: Item[]) => Item[];
  historyWindow: () => Promise<{ items: Item[] }>;
  runAgentTurn: (
    agentInput: string,
    extras: { images?: InboundImages },
    continuation?: { history: Item[] },
  ) => Promise<R>;
}

export async function deliverAddressedReply<R extends AgentTurnResult>(
  turn: AddressedReplyTurn<R>,
  result: R,
): Promise<R> {
  const {
    deps,
    input,
    session,
    strictReadOnly,
    sessionTurn,
    surfaceToolDeps,
    spine,
    ackText,
    defaultDestination,
    postKeys,
    postProvenance,
    isPollFire,
    surfaceName,
    inbound,
    replyCheck,
    filterHistory,
    historyWindow,
    runAgentTurn,
  } = turn;
  if (replyCheck && !replyCheck.enforce && result.reply.trim() && !result.silent && !result.stopped)
    void replyCheck.check(result.reply).catch(swallowAs("orchestrator: observed reply check", undefined));
  const followedUpByPerson = !input.addressed && spokenByPerson(input.origin) && !sessionTurn;
  if (
    (input.addressed || followedUpByPerson) &&
    !strictReadOnly &&
    input.surfaceTools &&
    surfaceToolDeps &&
    !input.cancel?.aborted &&
    spine.surfaceOutboundCount === 0 &&
    !result.silent &&
    !result.stopped
  ) {
    const primaryReply = stripAckPrefix(result.reply ?? "", ackText()).trim();
    if (input.addressed && primaryReply && defaultDestination) {
      try {
        await enqueueDirectReply({
          deliveries: deps.deliveries,
          destination: defaultDestination,
          text: primaryReply,
          key: postKeys.key(defaultDestination, postKeys.take()),
          postProvenance,
          ...(result.retracted ? { retracted: result.retracted } : {}),
        });
        spine.surfaceOutboundCount += 1;
        if (input.runId) deps.turnStream.markSurfacePosted(input.runId);
      } catch (e) {
        reportFailure("orchestrator: direct reply delivery", e, `session=${session.id}`);
      }
    }
    if (
      spine.surfaceOutboundCount === 0 &&
      !result.pendingApprovals?.length &&
      (primaryReply || (input.addressed && !isPollFire))
    ) {
      const nudgeHistory = filterHistory(forModelContext((await historyWindow()).items));
      result = await runAgentTurn(
        input.addressed
          ? `[system] You were addressed directly. Reply with the \`${surfaceName}\` tool's \`post\` action, or decline explicitly with finish_silently — ending the turn without either is not allowed here.`
          : `[system] Your text above was not delivered: in this thread only the \`${surfaceName}\` tool's \`post\` action reaches people. Post your reply with \`post\`, or decline explicitly with finish_silently.`,
        inbound.images.length ? { images: inbound.images } : {},
        { history: nudgeHistory },
      );
      if (input.addressed && spine.surfaceOutboundCount === 0 && !result.silent && !result.stopped) {
        const fallback = stripAckPrefix(result.reply ?? "", ackText()).trim();
        if (fallback && defaultDestination) {
          try {
            await enqueueDirectReply({
              deliveries: deps.deliveries,
              destination: defaultDestination,
              text: fallback,
              key: postKeys.key(defaultDestination, postKeys.take()),
              postProvenance,
            });
            spine.surfaceOutboundCount += 1;
            if (input.runId) deps.turnStream.markSurfacePosted(input.runId);
          } catch (e) {
            console.error(`[orchestrator] shed-reply fallback delivery failed session=${session.id}:`, errMessage(e));
          }
        } else {
          console.error(`[orchestrator] addressed turn ended silent after nudge session=${session.id}`);
        }
      }
    }
  }
  return result;
}
