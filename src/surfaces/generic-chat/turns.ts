import type { App } from "../../api/app-types.ts";
import type { RunStore } from "../../runs/run-store.ts";
import type { TurnStream } from "../../runs/turn-stream.ts";
import { CURATED_ACK_EMOJI, DEFAULT_ACK_REACTIONS } from "../../slack/ack-emoji.ts";
import type { Delivery, GatewayContext } from "../../types.ts";
import { reportFailureAs } from "../../util/errors.ts";
import { reactionDetectGuidance, reactionInstruction } from "../reactions.ts";
import { createRunWaiter } from "../run-wait.ts";
import { HANDOFF_INSTRUCTION, runSurfaceTurn, type SurfaceTurnBody } from "../turn-driver.ts";
import { createTurnFlow, drivenLive, liveRunHoldsDelivery, runDeliveryId } from "../turn-flow.ts";
import { GENERIC_CHAT, type GenericChatRef } from "./protocol.ts";
import { createGenericChatTransport, type GenericChatTransportDeps } from "./transport.ts";

const ACK_PICKS = [...CURATED_ACK_EMOJI, ...DEFAULT_ACK_REACTIONS];

export interface GenericChatTurn {
  where: GenericChatRef;
  authorId: string;
  trigger: string;
  body: SurfaceTurnBody;
  unprompted?: boolean;
  synthetic?: boolean;
}

export type GenericChatTurns = ReturnType<typeof createGenericChatTurns>;

function gatewayContext(where: GenericChatRef, chatName: string | undefined): GatewayContext {
  const hostIds = { chat: where.chat, ...(where.thread ? { thread: where.thread } : {}) };
  const reactions = { instructions: reactionInstruction("", false), reactionGuidance: reactionDetectGuidance("") };
  if (where.kind === "dm") return { location: "a direct message with the user", hostIds, ...reactions };
  return {
    location: chatName ? `the group chat "${chatName}"` : "a group chat",
    hostIds,
    ...(chatName ? { details: { chat_name: chatName } } : {}),
    ...reactions,
    instructions: `${reactions.instructions}\n\n${HANDOFF_INSTRUCTION}`,
  };
}

export function createGenericChatTurns(
  deps: GenericChatTransportDeps & {
    app: Pick<
      App,
      "turn" | "ackDeliveryByKey" | "getRun" | "setRunDeliveryState" | "ingestSurfaceEvents" | "readSurfaceMessages"
    >;
    runs: Pick<RunStore, "get" | "watchSession">;
    turnStream: TurnStream;
    pickAckEmoji?: (text: string, candidates: readonly string[]) => Promise<string | undefined>;
  },
) {
  const flow = createTurnFlow(
    {
      submitTurn: (body) => deps.app.turn({ ...body, surface: GENERIC_CHAT }),
      waitRun: createRunWaiter({ runs: deps.runs, turnStream: deps.turnStream, getRun: (id) => deps.app.getRun(id) }),
      ackRunDelivery: (runId) => deps.app.ackDeliveryByKey(`run:${runId}`),
    },
    GENERIC_CHAT,
  );
  const reportEditRef = async (runId: string, editRef: string): Promise<void> => {
    if (!(await deps.app.setRunDeliveryState(runId, { editRef }))) throw new Error(`run ${runId} not found`);
  };

  async function held(d: Delivery): Promise<boolean> {
    const runId = runDeliveryId(d);
    if (!runId || !liveRunHoldsDelivery(flow.inFlightRuns, d)) return false;
    return flow.inFlightRuns.has(runId) || drivenLive((await deps.runs.get(runId))?.request ?? {});
  }

  function start(turn: GenericChatTurn): Promise<void> {
    const { where, body } = turn;
    const label = `chat=${where.chat} at=${turn.trigger}`;
    const transport = createGenericChatTransport(deps, turn);
    return new Promise<void>((resolve, reject) => {
      const done = runSurfaceTurn({ flow, label: GENERIC_CHAT, reportEditRef }, transport, {
        kind: where.kind === "dm" ? "dm" : "channel",
        trigger: turn.trigger,
        where: label,
        ...(turn.unprompted ? { unprompted: true } : {}),
        ...(turn.synthetic ? { synthetic: true } : {}),
        ackEmoji: {
          candidates: () => DEFAULT_ACK_REACTIONS,
          pick: async () => deps.pickAckEmoji?.(body.text, ACK_PICKS),
        },
        prepare: async () => ({
          ...body,
          gatewayContext: gatewayContext(where, body.conversation.channelName),
          liveReplies: true,
        }),
        onAccepted: resolve,
        onRejected: (reason) => reject(new Error(reason)),
      });
      done.then(resolve, reject);
      done.catch(reportFailureAs("generic-chat: turn", undefined, label));
    });
  }

  return { start, held };
}
