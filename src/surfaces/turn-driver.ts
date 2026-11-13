import { replyEditNote } from "../delivery/run-result-delivery.ts";
import type { OutgoingAttachment, TurnResult } from "../types.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import type { ReplyReaction } from "./reactions.ts";
import { postThenAckRunDelivery, refusalDelivery, refusalNote } from "./refusals.ts";
import { turnFailureText, type CoreTurnBody, type TurnFlow } from "./turn-flow.ts";
import {
  createAckPresenter,
  createGoalNoticePresenter,
  type AckPresenter,
  type GoalNoticeView,
} from "./turn-presenters.ts";

export interface SurfaceTransport {
  post(
    text: string,
    opts?: { idempotencyKey?: string; note?: string; notice?: boolean; fileIds?: readonly string[] },
  ): Promise<string | undefined>;
  postPrivate(text: string, opts?: { transient?: boolean }): Promise<void>;
  edit(ref: string, text: string): Promise<void>;
  remove(ref: string): Promise<void>;
  react(ref: string, name: string, on: boolean): Promise<void>;
  applyReactions(reactions: readonly ReplyReaction[]): Promise<void>;
  typing(on: boolean, run?: { runId: string; emoji(): Promise<string> | undefined }): Promise<void>;
  upload(attachments: OutgoingAttachment[]): Promise<{ fileIds?: readonly string[]; failureNote?: string }>;
  render(markdown: string): string;
  escape(text: string): string;
  readReply(reply: string): { text: string; reactions: ReplyReaction[] };
}

export type SurfaceTurnBody = Omit<CoreTurnBody, "origin" | "approval">;

export interface SurfaceTurn {
  kind: "dm" | "channel";
  trigger: string;
  where: string;
  unprompted?: boolean;
  synthetic?: boolean;
  fromBot?: boolean;
  prepare(): Promise<SurfaceTurnBody | undefined>;
  ackEmoji: { candidates(): readonly string[]; pick(): Promise<string | undefined> };
  taskAck?: { move(runId: string, first: boolean): Promise<void>; finish(runId: string): Promise<void> };
  handOff?(runId: string, reply: string): Promise<boolean>;
  onAccepted?(): void;
  onRejected?(reason: string): void;
}

export const HANDOFF_INSTRUCTION =
  "When work needs another person's own logins, files or memory, follow the `hand-off` skill.";

export function statusPlaceholderKey(runId: string): string {
  return `status:run:${runId}`;
}

function turnOrigin(turn: SurfaceTurn): NonNullable<CoreTurnBody["origin"]> {
  const at = turn.trigger;
  if (!turn.unprompted) return { kind: "human", ...(at ? { messageTs: at } : {}) };
  if (turn.synthetic) return { kind: "ambient" };
  return { kind: "ambient", ...(at ? { entryTs: at } : {}), ...(turn.fromBot ? {} : { live: true }) };
}

export async function runSurfaceTurn(
  deps: { flow: TurnFlow; label: string; reportEditRef?(runId: string, ref: string): Promise<void> },
  transport: SurfaceTransport,
  turn: SurfaceTurn,
): Promise<void> {
  const { label } = deps;
  const { callCore, inFlightRuns, ackRunDelivery } = deps.flow;
  const unprompted = turn.unprompted === true;
  let queuedRunId: string | undefined;
  let accepted = false;

  const finishTaskAck = async (): Promise<void> => {
    if (queuedRunId) await turn.taskAck?.finish(queuedRunId);
  };
  let ack: AckPresenter | undefined;
  const startAck = (): AckPresenter =>
    (ack ??= createAckPresenter({
      taskManaged: !!turn.taskAck,
      postAck: async (text) => {
        const ref = await transport.post(
          transport.render(text),
          queuedRunId ? { idempotencyKey: statusPlaceholderKey(queuedRunId) } : undefined,
        );
        if (!ref || !queuedRunId || unprompted || !deps.reportEditRef) return;
        try {
          await deps.reportEditRef(queuedRunId, ref);
        } catch (error) {
          await transport
            .remove(ref)
            .catch(swallowAs(`${label}: delete status message after edit-ref failure`, undefined));
          throw error;
        }
      },
      addReaction: (name) => transport.react(turn.trigger, name, true),
      removeReaction: (name) => transport.react(turn.trigger, name, false),
      emojiCandidates: turn.ackEmoji.candidates(),
      emojiPick: turn.taskAck ? undefined : turn.ackEmoji.pick(),
    }));
  const acknowledges = !unprompted || !turn.synthetic;
  if (!unprompted) startAck();
  const goalNotice = unprompted
    ? undefined
    : createGoalNoticePresenter({
        escape: transport.escape,
        post: (text) => transport.post(text, { notice: true }),
        update: (ref, text) => transport.edit(ref, text),
        onError: (error) => console.error(`[${label}] goal notice update failed:`, (error as Error).message),
      });
  const settleAck = async (): Promise<void> => {
    await ack?.settle().catch(swallowAs(`${label}: ack settle`, undefined));
  };

  const body = await turn.prepare();
  if (!body) return settleAck();

  let result: TurnResult;
  try {
    result = await callCore(
      { ...body, origin: turnOrigin(turn) },
      {
        deferDeliveryAck: true,
        ...(turn.synthetic
          ? {}
          : {
              onReplying: () => {
                if (acknowledges) startAck();
                if (queuedRunId)
                  void transport
                    .typing(true, { runId: queuedRunId, emoji: () => ack?.emoji() })
                    .catch(swallowAs(`${label}: typing on`, undefined));
              },
            }),
        onQueued: async (runId) => {
          queuedRunId = runId;
          accepted = true;
          turn.onAccepted?.();
          await turn.taskAck?.move(runId, true);
        },
        onSteered: async (runId) => {
          accepted = true;
          turn.onAccepted?.();
          await turn.taskAck?.move(runId, false);
        },
        ...(acknowledges
          ? {
              onFirstBlock: (blockText: string) => startAck().onFirstBlock(transport.readReply(blockText).text),
              onSurfacePosted: () => startAck().onSurfacePosted(),
            }
          : {}),
        ...(goalNotice
          ? {
              onGoal: (goal: GoalNoticeView) => {
                void goalNotice.onGoal(goal);
              },
            }
          : {}),
      },
    );
    await goalNotice?.settle();
  } catch (err) {
    await settleAck();
    if (unprompted) {
      if (!accepted) turn.onRejected?.(errMessage(err));
      console.error(`[${label}] unprompted turn errored (staying quiet) ${turn.where}: ${(err as Error).message}`);
    } else {
      console.error(`[${label}] turn errored ${turn.where}: ${errMessage(err)}`);
      const note = `⚠️ ${turnFailureText(err)}`;
      if (ack?.postedAck()) await transport.post(note);
      else await transport.postPrivate(note);
    }
    return;
  } finally {
    if (queuedRunId) void transport.typing(false).catch(swallowAs(`${label}: typing off`, undefined));
  }

  const afterPost = (runId: string, post: () => Promise<unknown>): Promise<void> =>
    postThenAckRunDelivery({ post, ack: () => ackRunDelivery(runId), release: () => inFlightRuns.delete(runId) });

  if (result.steered) {
    await settleAck();
    if (result.stopped) await transport.postPrivate("Stopped.", { transient: true });
    return;
  }

  if (result.status === "silent") {
    if (unprompted) console.error(`[${label}] turn.silent (no reply) ${turn.where}`);
    await settleAck();
    await finishTaskAck();
    return;
  }

  if (result.status === "react") {
    await settleAck();
    const names = result.reactions ?? [];
    if (names.length) await transport.applyReactions([{ names }]);
    await finishTaskAck();
    console.error(`[${label}] turn.react (acknowledged) ${turn.where} emoji=${names.join(",")}`);
    return;
  }

  if (result.status === "ok") {
    if (queuedRunId && (await turn.handOff?.(queuedRunId, result.reply ?? ""))) {
      ackRunDelivery(queuedRunId);
      await settleAck();
      await finishTaskAck();
      return;
    }
    const { text: replyBody, reactions } = transport.readReply(result.reply ?? "");
    const hasNonText = !!(result.attachments?.length || reactions.length || result.pendingApprovals?.length);
    let reply = result.stopped ? "" : "(no response)";
    if (replyBody) reply = transport.render(replyBody);
    else if (hasNonText) reply = "";
    const deliverReply = async (): Promise<void> => {
      const uploaded = result.attachments?.length ? await transport.upload(result.attachments) : {};
      await ack?.drain();
      const note = replyEditNote(result.retracted);
      if (reply || uploaded.fileIds?.length)
        await transport.post(reply, {
          ...(note ? { note } : {}),
          ...(uploaded.fileIds?.length ? { fileIds: uploaded.fileIds } : {}),
          ...(queuedRunId ? { idempotencyKey: `run:${queuedRunId}` } : {}),
        });
      if (uploaded.failureNote) await transport.post(uploaded.failureNote);
      await transport.applyReactions(reactions);
      await settleAck();
      await finishTaskAck();
    };
    try {
      if (queuedRunId) await afterPost(queuedRunId, deliverReply);
      else await deliverReply();
    } catch (err) {
      await settleAck();
      if (!queuedRunId) throw err;
      console.error(
        `[${label}] reply post failed after run ${queuedRunId} finished (${turn.where}): ${(err as Error).message} — leaving delivery run:${queuedRunId} for the recovery poller`,
      );
      return;
    }
  } else if (result.status === "pending_approval") {
    await settleAck();
    if (!result.pendingApprovals?.length) {
      const note = result.reason ?? "This conversation is waiting on a pending approval.";
      if (unprompted) console.error(`[${label}] turn.pending_approval (no card) ${turn.where}: ${note}`);
      else if (ack?.postedAck()) await transport.post(note);
      else await transport.postPrivate(note);
    }
  } else {
    await settleAck();
    const delivery = refusalDelivery(result, unprompted);
    const note = refusalNote(result, turn.kind);
    const runKey = queuedRunId ? { idempotencyKey: `run:${queuedRunId}` } : undefined;
    if (delivery === "thread") {
      if (!queuedRunId) {
        await transport.post(note);
        return;
      }
      await afterPost(queuedRunId, async () => {
        await transport.post(note, runKey);
        await finishTaskAck();
      });
      return;
    }
    if (delivery === "silent") {
      await finishTaskAck();
      if (queuedRunId && result.refusalKind === "security_quarantine") inFlightRuns.delete(queuedRunId);
      else if (queuedRunId) ackRunDelivery(queuedRunId);
      console.error(
        `[${label}] unprompted turn ${result.status} (staying quiet) ${turn.where}: ${result.reason ?? "refused"}`,
      );
      return;
    }
    const postFailure = async (): Promise<void> => {
      if (turn.kind === "dm" || ack?.postedAck()) await transport.post(note, runKey);
      else await transport.postPrivate(note);
      await finishTaskAck();
    };
    if (queuedRunId) await afterPost(queuedRunId, postFailure);
    else await postFailure();
  }
  await finishTaskAck();
}
