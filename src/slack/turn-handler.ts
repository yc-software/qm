import { performance } from "node:perf_hooks";
import { slackFailureText } from "./turn-flow.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import {
  type ActorAssertion,
  type ChannelMeta,
  type ConversationTurn,
  type OverheardMessage,
  type ReactionTally,
  type RunTaskView,
  type GoalNoticeView,
  type GoalNoticePresenter,
  createGoalNoticePresenter,
  type SlackFile,
  type TaskListPresenter,
  DEFAULT_ACK_REACTIONS,
  REACTION_DETECT_GUIDANCE,
  approvalMessage,
  botIdentityArgs,
  buildReactionTurnText,
  createAckPresenter,
  createDeduper,
  createTaskListPresenter,
  createThreadTracker,
  decodeSlackEntities,
  dedupeKey,
  dedupedRun,
  deliveryCandidatesFor,
  deliveryMetadata,
  channelThreadRef,
  dmThreadRef,
  downloadSlackFile,
  encodeDeliveryTarget,
  groupDmDisplayName,
  hasContent,
  hydrateSlackFiles,
  isExternallyShared,
  isMpim,
  type SurfaceHeaderClient,
  maybeInterceptStop,
  postThenAckRunDelivery,
  type PostMessageArgs,
  postWithVerify,
  processInboundFiles,
  safeChunks,
  SLACK_POST_SPLIT_LIMIT,
  refusalDelivery,
  refusalNote,
  renderConversationView,
  resolveReactionTargets,
  shouldSurfaceReaction,
  slackReplyArgs,
  stripMention,
  threadHasBotStake,
  toSlackMrkdwn,
  uploadAttachments,
  uploadFailureNote,
} from "./lib.ts";
import type { GatewayContext, TurnResult } from "../types.ts";
import type { AckGate } from "./deferred-ack.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { CoreTurnBody, TurnFlow } from "./turn-flow.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { Mirror } from "./mirror.ts";
import type { ConversationSerializer } from "./conversation-view.ts";
import { reactionTallies } from "./conversation-view.ts";
import type { SlackReactionEvent } from "./payloads.ts";
import type { Approvals } from "./approvals.ts";
import type { AckEmojiPicker } from "./ack-emoji.ts";
import {
  type SlackConversationKind,
  applyAndLogReactions,
  cleanAgentReplyForSlack,
  conversationPlaceLabel,
  slackSurfaceInstructions,
} from "./messaging.ts";

interface Incoming {
  kind: "dm" | "channel";
  channel: string;
  userId: string | undefined;
  actor?: ActorAssertion;
  authorName?: string;
  rawText: string;
  files: SlackFile[];
  threadTs?: string;
  ts: string;
  unprompted?: boolean;
  botAuthored?: boolean;
  synthetic?: boolean;
  recvAt?: number;
  recvWall?: number;
  ackGate?: AckGate;
  eventTs?: number;
  prefetched?: {
    actor: ActorAssertion;
    timezone?: string;
    info: ChannelMeta | undefined;
    audience: ActorAssertion[];
    publishMembers?: ActorAssertion[];
    slackIdsByPrincipal?: Map<string, string>;
  };
}

export interface TurnHandler {
  handleIncoming(inc: Incoming, client: any): Promise<void>;
  dispatch(key: string, inc: Incoming, client: any): Promise<void>;
  handleReactionEvent(evt: SlackReactionEvent, eventId: string | undefined, client: any, added: boolean): Promise<void>;
  botHasStakeInThread(client: any, channel: string, threadTs: string): Promise<boolean>;
}

function channelType(kind: SlackConversationKind, conversationKind: SlackConversationKind): string {
  if (kind === "dm") return "im";
  return conversationKind === "group" ? "mpim" : "channel";
}

function channelLocation(
  conversationKind: SlackConversationKind,
  channelName: string | undefined,
  channel: string,
): string {
  if (conversationKind === "group") return "a group direct message";
  return channelName ? `#${channelName}` : `channel ${channel}`;
}

export function createTurnHandler(deps: {
  core: SlackCoreClient;
  flow: TurnFlow;
  directory: Directory;
  mirror: Mirror;
  serializer: ConversationSerializer;
  approvals: Approvals;
  ackEmoji: AckEmojiPicker;
  ackEmojiCandidates?: () => readonly string[] | null;
  ids: BotIdentity;
  threads: ReturnType<typeof createThreadTracker>;
  deduper: ReturnType<typeof createDeduper>;
  externalParticipantsEnabled(): Promise<boolean>;
  allowActor?: (actor: ActorAssertion) => boolean;
  markEvent?: () => void;
  botToken: string;
  trustedFileHost?: string;
  ensureHeader?: (
    client: SurfaceHeaderClient,
    channel: string,
    scopeId: string,
    kind: "dm" | "channel",
    ensureOpts?: { pinNew?: boolean },
  ) => void;
}): TurnHandler {
  const {
    core,
    flow,
    directory,
    mirror,
    serializer,
    approvals,
    ackEmoji,
    ids,
    threads,
    deduper,
    externalParticipantsEnabled,
  } = deps;
  const { classifyUserCached, classifyActor, getChannelInfo, channelMembership } = directory;
  const { mirrorSelfPost, mirrorMessageEvent } = mirror;
  const { callCore, inFlightRuns, inFlightRunByThread, ackRunDelivery } = flow;

  const reactionsInFlight = new Set<string>();

  async function botHasStakeInThread(client: any, channel: string, threadTs: string): Promise<boolean> {
    const cached = threads.get(channel, threadTs);
    if (cached !== undefined) return cached;
    try {
      const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200 });
      const present = threadHasBotStake(res.messages ?? [], ids.botUserId, ids.ownBotId);
      threads.mark(channel, threadTs, present);
      return present;
    } catch {
      return false;
    }
  }

  async function handleIncoming(inc: Incoming, client: any): Promise<void> {
    deps.markEvent?.();
    const t0 = inc.recvAt ?? performance.now();
    const slackInflightMs =
      inc.recvWall !== undefined && inc.eventTs !== undefined
        ? Math.max(0, Math.round(inc.recvWall - inc.eventTs * 1000))
        : undefined;
    let classified: { actor: ActorAssertion; timezone?: string };
    if (inc.actor) classified = { actor: inc.actor };
    else if (inc.prefetched)
      classified = {
        actor: inc.prefetched.actor,
        ...(inc.prefetched.timezone ? { timezone: inc.prefetched.timezone } : {}),
      };
    else classified = await classifyUserCached(client, inc.userId);
    const actor = classified.actor;
    if (deps.allowActor && !deps.allowActor(actor)) return;
    const timezone = classified.timezone;
    const text = stripMention(inc.rawText, ids.botUserId);
    if (!hasContent(text, inc.files)) return;

    let audience: ActorAssertion[] = [actor];
    let channelRef: string | undefined;
    let channelName: string | undefined;
    let threadRef: string;
    let replyThreadTs: string | undefined;
    let isPrivate: boolean | undefined;
    let isMpimChannel: boolean | undefined;
    let publishMembers: ActorAssertion[] | undefined;
    let channelInfo: ChannelMeta | undefined;
    let slackIdsByPrincipal: Map<string, string> | undefined;
    let conversationKind: SlackConversationKind = inc.kind;
    let allowedTs: Set<string> = new Set();
    const postReply = async (
      msg: string,
      blocks?: Array<Record<string, unknown>>,
      idempotencyKey?: string,
    ): Promise<string | undefined> => {
      const replyArgs = (text: string, withBlocks: boolean): Record<string, unknown> => ({
        ...slackReplyArgs(inc.channel, text, replyThreadTs, { threadOnly: inc.kind === "channel", unfurlLinks: false }),
        ...(withBlocks && blocks ? { blocks } : {}),
      });
      if (idempotencyKey) {
        const res = await postWithVerify(client, replyArgs(msg, true) as PostMessageArgs, idempotencyKey);
        for (const part of res.parts ?? [{ ts: res.ts, text: msg }]) {
          mirrorSelfPost(inc.channel, part.ts, part.text, { sub: replyThreadTs });
        }
        return res.ts;
      }
      const parts = blocks ? [msg] : safeChunks(msg, SLACK_POST_SPLIT_LIMIT);
      let firstTs: string | undefined;
      for (const [i, part] of parts.entries()) {
        const ts = (await client.chat.postMessage(replyArgs(part, parts.length === 1))).ts as string | undefined;
        mirrorSelfPost(inc.channel, ts, part, { sub: replyThreadTs });
        if (i === 0) firstTs = ts;
      }
      return firstTs;
    };

    const ephemeralOrSay = async (msg: string): Promise<void> => {
      if (inc.kind === "channel") {
        await client.chat
          .postEphemeral({ channel: inc.channel, user: inc.userId, text: msg })
          .catch(swallowAs("slack: chat.postEphemeral", undefined));
      } else {
        await postReply(msg);
      }
    };

    if (inc.kind === "dm") {
      threadRef = dmThreadRef(inc.channel, inc.threadTs);
      replyThreadTs = inc.threadTs;
      if (!actor.isBot && !actor.isExternalGuest)
        deps.ensureHeader?.(client, inc.channel, `personal:${actor.externalId}`, "dm");
    } else {
      channelRef = inc.channel;
      const info = inc.prefetched ? inc.prefetched.info : await getChannelInfo(client, inc.channel);
      channelInfo = info;
      isPrivate = info?.is_private;
      isMpimChannel = isMpim(info);
      if (isMpimChannel) conversationKind = "group";
      channelName = info?.name;
      if (!isMpimChannel && !isExternallyShared(info) && !actor.isBot && !actor.isExternalGuest)
        deps.ensureHeader?.(client, inc.channel, `channel:${inc.channel}`, "channel");
      const root = inc.threadTs ?? inc.ts;
      threadRef = channelThreadRef(conversationKind, inc.channel, root);
      replyThreadTs = root;
    }

    let queuedRunId: string | undefined;
    let accepted = false;
    let taskList: TaskListPresenter | undefined;
    let goalNotice: GoalNoticePresenter | undefined;

    if (inc.kind === "channel") {
      const membership = inc.prefetched
        ? {
            audience: inc.prefetched.audience,
            publishMembers: inc.prefetched.publishMembers,
            slackIdsByPrincipal: inc.prefetched.slackIdsByPrincipal,
          }
        : await channelMembership(client, inc.channel, actor, inc.userId, channelInfo);
      audience = membership.audience;
      publishMembers = membership.publishMembers;
      slackIdsByPrincipal = membership.slackIdsByPrincipal;
      if (conversationKind === "group") channelName = groupDmDisplayName(audience) ?? channelName;
    }

    const gatewayContext: GatewayContext =
      inc.kind === "dm"
        ? {
            location: "a direct message with the user",
            details: { channel: inc.channel, ...(inc.threadTs ? { thread_ts: inc.threadTs } : {}) },
            instructions: slackSurfaceInstructions(inc.kind),
            reactionGuidance: REACTION_DETECT_GUIDANCE,
            ...(ids.botHandle ? { botHandle: ids.botHandle } : {}),
          }
        : {
            location: channelLocation(conversationKind, channelName, inc.channel),
            details: {
              channel: inc.channel,
              ...(channelName
                ? { channel_name: conversationPlaceLabel(conversationKind, channelName, inc.channel) }
                : {}),
              ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
            },
            instructions: slackSurfaceInstructions(inc.kind),
            reactionGuidance: REACTION_DETECT_GUIDANCE,
            ...(ids.botHandle ? { botHandle: ids.botHandle } : {}),
          };

    if (audience.some((a) => a.isExternalGuest) && !(await externalParticipantsEnabled())) {
      if (!inc.unprompted) {
        await ephemeralOrSay(
          "I can't respond here — this conversation isn't fully internal. Try a DM or a fully-internal channel.",
        );
      }
      return;
    }

    if (!inc.unprompted) {
      const intercepted = await maybeInterceptStop({
        text,
        threadRef,
        getInFlightRun: (ref) =>
          inFlightRunByThread.get(ref) ??
          core.activeRunForThread(ref).catch(swallowAs("slack: active-run lookup", undefined)),
        signalAbort: (runId) => core.signalRunAbort(runId),
      }).catch(swallowAs("slack: abort signal", true));
      if (intercepted) return;
    }

    const ack = inc.unprompted
      ? undefined
      : createAckPresenter({
          postAck: async (text) => {
            const rendered = toSlackMrkdwn(text);
            if (await taskList?.addLead(rendered)) return;
            const ts = await postReply(rendered);
            if (ts) await taskList?.attach(ts, rendered);
          },
          addReaction: (name) => client.reactions.add({ channel: inc.channel, timestamp: inc.ts, name }).then(() => {}),
          removeReaction: (name) =>
            client.reactions.remove({ channel: inc.channel, timestamp: inc.ts, name }).then(() => {}),
          emojiCandidates: (() => {
            const override = deps.ackEmojiCandidates?.();
            return override?.length ? [...override] : [...DEFAULT_ACK_REACTIONS];
          })(),
          emojiPick: ackEmoji.requestAckEmoji(text, ackEmoji.ackPickCandidates(client), {
            channel: inc.channel,
            ts: inc.ts,
          }),
        });
    if (!inc.unprompted) {
      taskList = createTaskListPresenter({
        post: (text, blocks) => postReply(text, blocks),
        update: (ts, text, blocks, metadata) =>
          client.chat
            .update({
              channel: inc.channel,
              ts,
              text,
              blocks,
              ...(metadata ? { metadata } : {}),
              ...botIdentityArgs(),
            })
            .then(() => {
              mirrorSelfPost(inc.channel, ts, text, { sub: replyThreadTs, editedAt: Date.now() });
            }),
        checkpoint: async (ts) => {
          if (queuedRunId) await core.reportRunEditRef(queuedRunId, ts);
        },
        remove: (ts) => client.chat.delete({ channel: inc.channel, ts }).then(() => {}),
        onSurfacePosted: () => ack?.onSurfacePosted(),
        onError: (error) => console.error("[slack-plugin] task-list update failed:", (error as Error).message),
      });
    }
    if (!inc.unprompted) {
      goalNotice = createGoalNoticePresenter({
        post: (text, blocks) => postReply(text, blocks),
        update: (ts, text, blocks) =>
          client.chat.update({ channel: inc.channel, ts, text, blocks, ...botIdentityArgs() }).then(() => {
            mirrorSelfPost(inc.channel, ts, text, { sub: replyThreadTs, editedAt: Date.now() });
          }),
        onError: (error) => console.error("[slack-plugin] goal notice update failed:", (error as Error).message),
      });
    }
    const settleAck = async (): Promise<void> => {
      await ack?.settle().catch(swallowAs("slack: ack settle", undefined));
    };

    {
      const containerName = inc.kind === "dm" ? actor.displayName?.trim() || undefined : channelName;
      void mirrorMessageEvent(
        {
          channel: inc.channel,
          ts: inc.ts,
          text: inc.rawText,
          user: inc.userId,
          thread_ts: inc.threadTs,
          channel_type: channelType(inc.kind, conversationKind),
        },
        client,
        { kind: conversationKind, handled: true, ...(containerName ? { containerName } : {}) },
      );
    }

    if (inc.kind === "channel" && replyThreadTs) threads.mark(inc.channel, replyThreadTs, true);

    let conversationHeader: string | undefined;
    let priorTurns: ConversationTurn[] | undefined;
    let overheard: OverheardMessage[] | undefined;
    let detectContext: string | undefined;
    let detectOpener: string | undefined;
    let earlierFiles: SlackFile[] = [];
    if (inc.kind === "channel" || (inc.kind === "dm" && inc.threadTs)) {
      const serialized = await serializer.serializeSlackConversation(client, inc, {
        audience,
        ...(channelName ? { channelName } : {}),
        ...(isPrivate !== undefined ? { isPrivate } : {}),
        kind: conversationKind,
        ...(slackIdsByPrincipal ? { slackIdsByPrincipal } : {}),
      });
      earlierFiles = serialized.earlierFiles;
      const rendered = renderConversationView(serialized.view);
      if (rendered.header) conversationHeader = rendered.header;
      if (rendered.priorTurns.length) priorTurns = rendered.priorTurns;
      if (rendered.overheard.length) overheard = rendered.overheard;
      if (rendered.detectContext) detectContext = rendered.detectContext;
      if (rendered.detectOpener) detectOpener = rendered.detectOpener;
      allowedTs = rendered.allowedTs;
    }

    const ownFiles = inc.files.map((f) => (f.user || !inc.userId ? f : { ...f, user: inc.userId }));
    const inboundFiles = await hydrateSlackFiles(
      earlierFiles.length ? [...ownFiles, ...earlierFiles] : ownFiles,
      async (id) => {
        const response = await client.files.info({ file: id });
        return response?.file as SlackFile | undefined;
      },
    );
    const resolveFileAuthor = async (userId: string | undefined): Promise<string | undefined> =>
      userId ? (await classifyUserCached(client, userId)).actor.displayName : undefined;
    const { attachments, issues } = await processInboundFiles(
      inboundFiles,
      (f) =>
        downloadSlackFile(f, {
          token: deps.botToken,
          ...(deps.trustedFileHost ? { trustedHost: deps.trustedFileHost } : {}),
        }),
      (bytes) => core.stageBlob(bytes),
      resolveFileAuthor,
    );

    if (inc.unprompted && !text.trim() && attachments.length === 0) return;

    const turn: Omit<CoreTurnBody, "approval"> = {
      actor,
      conversation: {
        kind: conversationKind,
        threadRef,
        ...(channelRef ? { channelRef } : {}),
        ...(channelName ? { channelName } : {}),
        audience,
        ...(isPrivate !== undefined ? { isPrivate } : {}),
        ...(isMpimChannel !== undefined ? { isMpim: isMpimChannel } : {}),
        ...(publishMembers ? { publishMembers } : {}),
      },
      deliveryTarget: encodeDeliveryTarget(inc.channel, replyThreadTs),
      ...(() => {
        const candidates = deliveryCandidatesFor(conversationKind, inc.channel, replyThreadTs, channelName);
        return candidates ? { deliveryCandidates: candidates } : {};
      })(),
      text,
      gatewayContext,
      ...(inc.unprompted
        ? {
            unprompted: true,
            ...(inc.synthetic
              ? {}
              : { entryTs: inc.ts, ...(actor.isBot || inc.botAuthored ? {} : { liveActor: true }) }),
          }
        : { liveActor: true, triggerTs: inc.ts }),
      ...(actor.isBot ? { botActor: true } : {}),
      ...(conversationHeader ? { conversationHeader } : {}),
      ...(priorTurns ? { priorTurns } : {}),
      ...(overheard ? { overheard } : {}),
      ...(detectContext ? { detectContext } : {}),
      ...(detectOpener ? { detectOpener } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(issues.length ? { inboundNotes: issues } : {}),
      ...(timezone ? { timezone } : {}),
      ...(inc.ts && !inc.synthetic
        ? { redeliveryKey: `slack:${ids.botUserId || "bot"}:${inc.channel}:${inc.ts}` }
        : {}),
    };
    const tSubmit = performance.now();
    let result: TurnResult;
    try {
      result = await callCore(
        { ...turn, intakePreambleMs: Math.round(tSubmit - t0), clientSentAt: Date.now() },
        {
          deferOkAck: true,
          onQueued: (runId) => {
            queuedRunId = runId;
            inFlightRunByThread.set(threadRef, runId);
            accepted = true;
            inc.ackGate?.persisted();
          },
          // Folded into a live run: the envelope is durably accepted just the same, but the run
          // stays pinned to its own handler — claiming it here would unpin it on the way out.
          onSteered: () => {
            accepted = true;
            inc.ackGate?.persisted();
          },
          ...(ack
            ? {
                onFirstBlock: (blockText: string) => {
                  ack.onFirstBlock(cleanAgentReplyForSlack(blockText).text);
                },
                onSurfacePosted: () => ack.onSurfacePosted(),
              }
            : {}),
          ...(taskList
            ? {
                onTasks: async (tasks: RunTaskView[]) => {
                  await ack?.drain();
                  await taskList?.onTasks(tasks);
                },
              }
            : {}),
          ...(goalNotice
            ? {
                onGoal: (goal: GoalNoticeView) => {
                  void goalNotice?.onGoal(goal);
                },
              }
            : {}),
        },
      );
      await taskList?.settle();
      await goalNotice?.settle();
    } catch (err) {
      await settleAck();
      if (inc.unprompted) {
        if (!accepted) inc.ackGate?.failed(errMessage(err));
        console.error(
          `[slack-plugin] unprompted turn errored (staying quiet) ch=${inc.channel} ts=${inc.ts}: ${(err as Error).message}`,
        );
      } else {
        console.error(`[slack-plugin] turn errored ch=${inc.channel} ts=${inc.ts}: ${errMessage(err)}`);
        const note = `⚠️ ${slackFailureText(err)}`;
        if (ack?.postedAck()) await postReply(note);
        else await ephemeralOrSay(note);
      }
      return;
    } finally {
      if (queuedRunId) inFlightRunByThread.clear(threadRef, queuedRunId);
    }

    // This message was folded into a run that was already live. The handler that OWNS that run
    // delivers its reply; delivering here too is how one answer got posted twice. Settle this
    // trigger's own ack and stand down.
    if (result.steered) {
      await settleAck();
      return;
    }

    if (result.status === "silent") {
      if (inc.unprompted) console.error(`[slack-plugin] turn.silent (no reply) ch=${inc.channel} ts=${inc.ts}`);
      await settleAck();
      return;
    }

    if (result.status === "react") {
      await settleAck();
      const names = result.reactions ?? [];
      if (names.length) await applyAndLogReactions(client, inc.channel, inc.ts, [{ names }]);
      console.error(`[slack-plugin] turn.react (acknowledged) ch=${inc.channel} ts=${inc.ts} emoji=${names.join(",")}`);
      return;
    }

    if (result.status === "ok") {
      if (inc.kind === "channel" && replyThreadTs) threads.mark(inc.channel, replyThreadTs, true);
      const { text: replyBody, reactions, agentRequests } = cleanAgentReplyForSlack(result.reply ?? "");
      const actionableAgentRequests = inc.kind === "channel" ? agentRequests : [];
      const hasNonText = !!(
        result.attachments?.length ||
        reactions.length ||
        actionableAgentRequests.length ||
        result.pendingApprovals?.length
      );
      let reply = "(no response)";
      if (replyBody) reply = toSlackMrkdwn(replyBody);
      else if (hasNonText) reply = "";
      const postText = reply;
      const tDeliverStart = performance.now();
      const runKey = queuedRunId ? `run:${queuedRunId}` : undefined;
      const deliverReply = async (): Promise<void> => {
        let uploadError: unknown;
        if (result.attachments?.length) {
          try {
            await uploadAttachments(client, inc.channel, replyThreadTs, result.attachments, core);
          } catch (err) {
            uploadError = err;
            console.error("[slack-plugin] file upload failed:", (err as Error).message);
          }
        }
        await settleAck();
        const finalizedTaskList = postText
          ? ((await taskList?.finalize(postText, runKey ? deliveryMetadata(runKey) : undefined)) ?? false)
          : false;
        if (postText && !finalizedTaskList) await postReply(postText, undefined, runKey);
        if (uploadError) await postReply(uploadFailureNote(uploadError));
      };
      try {
        if (queuedRunId) {
          const runId = queuedRunId;
          await postThenAckRunDelivery({
            post: deliverReply,
            ack: () => ackRunDelivery(runId),
            release: () => inFlightRuns.delete(runId),
          });
        } else {
          await deliverReply();
        }
      } catch (err) {
        if (queuedRunId) {
          console.error(
            `[slack-plugin] reply post failed after run ${queuedRunId} finished (ch=${inc.channel} ts=${inc.ts}): ${(err as Error).message} — leaving delivery run:${queuedRunId} for the recovery poller`,
          );
          return;
        }
        throw err;
      }
      if (queuedRunId) {
        void core
          .reportTurnMetrics(queuedRunId, {
            deliverMs: Math.round(performance.now() - tDeliverStart),
            ...(slackInflightMs !== undefined ? { slackInflightMs } : {}),
          })
          .catch(swallowAs("slack: turn-metrics report", undefined));
      }
      const { directives, dropped } = resolveReactionTargets(reactions, allowedTs);
      if (dropped) console.error(`[slack-plugin] dropped ${dropped} reaction(s) with an unresolvable message id`);
      await applyAndLogReactions(client, inc.channel, inc.ts, directives);
      if (actionableAgentRequests.length) {
        await approvals.postAgentRequests(
          client,
          {
            requesterId: inc.userId,
            channel: inc.channel,
            ...(replyThreadTs ? { replyThreadTs } : {}),
            threadOnly: true,
            kind: conversationKind,
            ...(channelName ? { channelName } : {}),
            audience,
            ...(slackIdsByPrincipal ? { slackIdsByPrincipal } : {}),
          },
          actionableAgentRequests,
        );
      }
      if (result.pendingApprovals?.length) {
        await approvals.postApprovalButtons(
          client,
          {
            requesterId: inc.userId,
            channel: inc.channel,
            ...(replyThreadTs ? { replyThreadTs } : {}),
            triggerTs: inc.ts,
            threadOnly: inc.kind === "channel",
            turn,
            ...(allowedTs.size ? { allowedTs } : {}),
            ...(slackIdsByPrincipal ? { slackIdsByPrincipal } : {}),
            ...(ack?.postedAck() ? { ackedFirstBlock: ack.postedAck() } : {}),
          },
          result.pendingApprovals,
        );
      }
    } else if (result.status === "pending_approval") {
      const pendingApprovals = result.pendingApprovals ?? [];
      if (!pendingApprovals.length) {
        await settleAck();
        const note = result.reason ?? "This conversation is waiting on a pending approval.";
        if (inc.unprompted) {
          console.error(`[slack-plugin] turn.pending_approval (no card) ch=${inc.channel} ts=${inc.ts}: ${note}`);
        } else if (ack?.postedAck()) {
          await postReply(note);
        } else {
          await ephemeralOrSay(note);
        }
        return;
      }
      const baseCtx = {
        requesterId: inc.userId,
        channel: inc.channel,
        ...(replyThreadTs ? { replyThreadTs } : {}),
        triggerTs: inc.ts,
        threadOnly: inc.kind === "channel",
        turn,
        ...(allowedTs.size ? { allowedTs } : {}),
        ...(slackIdsByPrincipal ? { slackIdsByPrincipal } : {}),
        ...(ack?.postedAck() ? { ackedFirstBlock: ack.postedAck() } : {}),
      };
      await settleAck();
      if (inc.kind === "channel") {
        await approvals.postApprovalButtons(client, baseCtx, pendingApprovals);
      } else {
        approvals.rememberSlackApprovals(pendingApprovals, { ...baseCtx, approvalChannel: inc.channel });
        const msg = approvalMessage(pendingApprovals);
        await client.chat.postMessage({
          ...slackReplyArgs(inc.channel, msg.text, replyThreadTs, { threadOnly: false }),
          blocks: msg.blocks,
        });
      }
    } else {
      await settleAck();
      const delivery = refusalDelivery(result, inc.unprompted === true);
      if (delivery === "thread") {
        if (queuedRunId) {
          const runId = queuedRunId;
          const text = refusalNote(result, inc.kind);
          await postThenAckRunDelivery({
            post: () => postReply(text, undefined, `run:${runId}`),
            ack: () => ackRunDelivery(runId),
            release: () => inFlightRuns.delete(runId),
          });
        } else {
          await postReply(refusalNote(result, inc.kind));
        }
        return;
      }
      if (delivery === "silent") {
        if (queuedRunId && result.refusalKind === "security_quarantine") inFlightRuns.delete(queuedRunId);
        console.error(
          `[slack-plugin] unprompted turn ${result.status} (staying quiet) ch=${inc.channel} ts=${inc.ts}: ${result.reason ?? "refused"}`,
        );
        return;
      }
      if (ack?.postedAck()) await postReply(refusalNote(result, inc.kind));
      else await ephemeralOrSay(refusalNote(result, inc.kind));
    }
  }

  async function dispatch(key: string, inc: Incoming, client: any): Promise<void> {
    const eventTs = Number.parseFloat(inc.ts);
    const gate = inc.ackGate;
    const stamped: Incoming = {
      ...inc,
      recvAt: performance.now(),
      recvWall: Date.now(),
      ...(Number.isFinite(eventTs) && eventTs > 0 ? { eventTs } : {}),
      ...(gate
        ? {
            ackGate: {
              persisted: () => gate.persisted(),
              failed: (reason?: string) => {
                deduper.forget(key);
                gate.failed(reason);
              },
            },
          }
        : {}),
    };
    const ran = await dedupedRun(
      deduper,
      key,
      () => handleIncoming(stamped, client),
      (err) => {
        stamped.ackGate?.failed(errMessage(err));
        console.error("[slack-plugin] handler error:", errMessage(err));
      },
    );
    if (!ran) gate?.failed("already in flight on this instance");
  }

  async function getReactedMessage(
    client: any,
    channel: string,
    ts: string,
    full: boolean,
  ): Promise<{ text: string; threadTs?: string; reactions: ReactionTally[]; authorId?: string } | undefined> {
    try {
      const res = await client.reactions.get({ channel, timestamp: ts, full });
      const m = res?.message;
      if (!m) return undefined;
      return {
        text: decodeSlackEntities(String(m.text ?? "").trim()),
        ...(m.thread_ts && m.thread_ts !== ts ? { threadTs: String(m.thread_ts) } : {}),
        reactions: reactionTallies(m.reactions),
        ...(m.user ? { authorId: String(m.user) } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async function handleReactionEvent(
    evt: SlackReactionEvent,
    eventId: string | undefined,
    client: any,
    added: boolean,
  ): Promise<void> {
    const reactorId = evt.user;
    const channel = evt.item?.channel;
    const messageTs = evt.item?.ts;
    const emoji = evt.reaction;
    if (!reactorId || !channel || !messageTs || !emoji) return;

    const isDM = channel.startsWith("D");
    const onBotMessage = Boolean(ids.botUserId && evt.item_user === ids.botUserId);
    const onFollowedRoot = threads.get(channel, messageTs) === true;
    if (
      !shouldSurfaceReaction({
        itemType: evt.item?.type,
        reactorId,
        botUserId: ids.botUserId,
        isDM,
        onBotMessage,
        onFollowedRoot,
      })
    ) {
      return;
    }

    const flightKey = `${channel}:${messageTs}:${emoji}:${reactorId}:${added ? "+" : "-"}`;
    if (reactionsInFlight.has(flightKey)) return;
    reactionsInFlight.add(flightKey);
    try {
      const key = dedupeKey({
        event_id: eventId,
        channel,
        ts: `${messageTs}:${emoji}:${added ? "+" : "-"}:${reactorId}:${evt.event_ts ?? ""}`,
      });
      await dedupedRun(
        deduper,
        key,
        async () => {
          const reactorUser = await classifyUserCached(client, reactorId);
          const reactor = reactorUser.actor;
          if (reactor.isExternalGuest) return;
          if (deps.allowActor && !deps.allowActor(reactor)) return;
          let prefetched: Incoming["prefetched"];
          if (!isDM) {
            const info = await getChannelInfo(client, channel);
            const membership = await channelMembership(client, channel, reactor, reactorId, info);
            if (membership.audience.some((a) => a.isExternalGuest) && !(await externalParticipantsEnabled())) return;
            prefetched = {
              actor: reactor,
              ...(reactorUser.timezone ? { timezone: reactorUser.timezone } : {}),
              info,
              audience: membership.audience,
              ...(membership.publishMembers ? { publishMembers: membership.publishMembers } : {}),
              ...(membership.slackIdsByPrincipal ? { slackIdsByPrincipal: membership.slackIdsByPrincipal } : {}),
            };
          }
          const reactorName = reactor.displayName || "Someone";

          const msg = await getReactedMessage(client, channel, messageTs, added);
          let authorName: string | undefined;
          if (!onBotMessage && msg?.authorId && msg.authorId !== reactorId) {
            authorName = (await classifyActor(client, msg.authorId)).displayName;
          }

          const inc: Incoming = {
            kind: isDM ? "dm" : "channel",
            channel,
            userId: reactorId,
            rawText: buildReactionTurnText({
              reactorName,
              emoji,
              added,
              onBotMessage,
              ...(authorName ? { authorName } : {}),
              ...(msg?.text ? { messageText: msg.text } : {}),
              ...(msg?.reactions?.length ? { reactions: msg.reactions } : {}),
            }),
            files: [],
            ...(msg?.threadTs ? { threadTs: msg.threadTs } : {}),
            ts: messageTs,
            unprompted: true,
            synthetic: true,
            ...(prefetched ? { prefetched } : {}),
          };
          let heardWhere = "followed thread";
          if (isDM) heardWhere = "dm";
          else if (onBotMessage) heardWhere = "on my message";
          console.log(
            `[slack-plugin] heard reaction ${added ? "+" : "-"}:${emoji}: from ${reactorName} (${heardWhere}) → turn`,
          );
          await handleIncoming(inc, client);
        },
        (err) => console.error("[slack-plugin] handler error:", errMessage(err)),
      );
    } finally {
      reactionsInFlight.delete(flightKey);
    }
  }

  return { handleIncoming, dispatch, handleReactionEvent, botHasStakeInThread };
}
