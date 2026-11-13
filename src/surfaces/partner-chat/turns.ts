import type { App } from "../../api/app-types.ts";
import type { RunStore } from "../../runs/run-store.ts";
import type { TurnStream } from "../../runs/turn-stream.ts";
import type { ActorAssertion, Delivery } from "../../types.ts";
import { reportFailureAs } from "../../util/errors.ts";
import { createRunWaiter } from "../run-wait.ts";
import { runSurfaceTurn } from "../turn-driver.ts";
import { createTurnFlow, liveRunHoldsDelivery, runDeliveryId } from "../turn-flow.ts";
import type { PartnerChatClient } from "./client.ts";
import type { PartnerChatEvent } from "./protocol.ts";
import { createPartnerChatTransport } from "./transport.ts";

const SURFACE = "partner-chat";
const ACK_REACTIONS = ["eyes"];

export interface PartnerChatTurn {
  event: PartnerChatEvent;
  author: ActorAssertion;
  audience: ActorAssertion[];
  container: string;
  ts: string;
  replyTarget: string;
  replyThread?: string;
  followUp?: { detectContext: string; detectOpener?: string };
}

export type PartnerChatTurns = ReturnType<typeof createPartnerChatTurns>;

export function createPartnerChatTurns(deps: {
  app: Pick<App, "turn" | "ackDeliveryByKey" | "getRun" | "ingestSurfaceEvents">;
  client: PartnerChatClient;
  runs: Pick<RunStore, "get" | "watchSession">;
  turnStream: TurnStream;
  now?: () => number;
}) {
  const flow = createTurnFlow(
    {
      submitTurn: (body) => deps.app.turn({ ...body, surface: SURFACE }),
      waitRun: createRunWaiter({ runs: deps.runs, turnStream: deps.turnStream, getRun: (id) => deps.app.getRun(id) }),
      ackRunDelivery: (runId) => deps.app.ackDeliveryByKey(`run:${runId}`),
    },
    SURFACE,
  );

  async function held(d: Delivery): Promise<boolean> {
    const runId = runDeliveryId(d);
    if (!runId || !liveRunHoldsDelivery(flow.inFlightRuns, d)) return false;
    return flow.inFlightRuns.has(runId) || (await deps.runs.get(runId))?.request.liveReplies === true;
  }

  function start(turn: PartnerChatTurn): Promise<void> {
    const { event, container, replyTarget, replyThread } = turn;
    const { chat, message, account } = event;
    const transport = createPartnerChatTransport(
      { client: deps.client, app: deps.app, ...(deps.now ? { now: deps.now } : {}) },
      {
        chat: { account, kind: chat.kind, chat: chat.id },
        ...(replyThread ? { thread: replyThread } : {}),
        authorId: message.user.id,
      },
    );
    return new Promise<void>((resolve, reject) => {
      const done = runSurfaceTurn({ flow, label: SURFACE }, transport, {
        kind: chat.kind === "dm" ? "dm" : "channel",
        trigger: turn.ts,
        where: `chat=${chat.id} message=${message.id}`,
        ...(turn.followUp ? { unprompted: true } : {}),
        ackEmoji: { candidates: () => ACK_REACTIONS, pick: async () => undefined },
        prepare: async () => ({
          actor: turn.author,
          surfaceOrigin: {
            author: { surface: SURFACE, account, id: message.user.id },
            workspace: account,
            ...(replyThread ? { replyThread } : {}),
            audience: "internal",
          },
          conversation: {
            kind: chat.kind,
            threadRef: replyTarget,
            ...(chat.kind === "group" ? { channelRef: container, isPrivate: true } : {}),
            ...(chat.name ? { channelName: chat.name } : {}),
            audience: turn.audience,
          },
          deliveryTarget: replyTarget,
          ...(chat.kind === "group" && replyTarget !== container
            ? {
                deliveryCandidates: [
                  { target: replyTarget, label: "this thread" },
                  { target: container, label: chat.name ? `${chat.name} (the whole chat)` : "the whole chat" },
                ],
              }
            : {}),
          text: message.body,
          ...turn.followUp,
          liveReplies: true,
          redeliveryKey: `${SURFACE}:${account}:${chat.id}:${message.id}`,
        }),
        onAccepted: resolve,
        onRejected: (reason) => reject(new Error(reason)),
      });
      done.then(resolve, reject);
      done.catch(reportFailureAs("partner-chat: turn", undefined, `chat=${chat.id} message=${message.id}`));
    });
  }

  return { start, held };
}
