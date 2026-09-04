import { swallowAs } from "../util/errors.ts";
import { randomUUID } from "node:crypto";
import {
  type ActorAssertion,
  type AgentRequestActionId,
  type AgentRequestDirective,
  type ApprovalActionId,
  type StoredApproval,
  agentRequestMessage,
  approvalCardDestination,
  approvalMessage,
  botIdentityArgs,
  clip,
  createApprovalRegistry,
  createThreadTracker,
  dmThreadRef,
  encodeDeliveryTarget,
  inlineCode,
  isBoundaryRefusal,
  recoveredApprovalContext,
  resolveReactionTargets,
  slackReplyArgs,
  stripAckPrefix,
  toSlackMrkdwn,
  uploadAttachments,
  uploadFailureNote,
} from "./lib.ts";
import { resolveAgentRequestTarget } from "./approval-context.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { TurnResult } from "../types.ts";
import type { CoreBridge, CoreTurnBody } from "./core-bridge.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import {
  type SlackConversationKind,
  applyAndLogReactions,
  channelAgentLabel,
  cleanAgentReplyForSlack,
  conversationPlaceLabel,
  personalAgentLabel,
  tryUpdateSlackMessage,
  updateSlackMessage,
} from "./messaging.ts";

interface SlackApprovalContext {
  requesterId: string;
  channel: string;
  replyThreadTs?: string;
  triggerTs?: string;
  threadOnly: boolean;
  approvalChannel: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  turn: Omit<CoreTurnBody, "approval">;
  allowedTs?: Set<string>;
  slackIdsByPrincipal?: ReadonlyMap<string, string>;
  agentRequest?: SlackAgentRequestContext;
  ackedFirstBlock?: string;
  recovered?: boolean;
}

interface SlackAgentRequestContext {
  requesterId: string;
  targetUserId: string;
  targetDisplayName?: string;
  originChannel: string;
  originConversationKind?: SlackConversationKind;
  originThreadTs?: string;
  originThreadOnly: boolean;
  originChannelName?: string;
  originStatusTs?: string;
  dmChannel: string;
  dmMessageTs?: string;
  task: string;
  originAgentLabel: string;
  targetAgentLabel: string;
}

type ApprovalScope = "once" | "session" | "always";

function approvalScope(actionId: ApprovalActionId): ApprovalScope | "deny" {
  if (actionId === "hilo_allow_once") return "once";
  if (actionId === "hilo_allow_session") return "session";
  if (actionId === "hilo_allow_always") return "always";
  return "deny";
}

function agentRequestAction(actionId: AgentRequestActionId): "run" | "deny" {
  return actionId === "agent_request_run" ? "run" : "deny";
}

export interface Approvals {
  rememberSlackApprovals(
    approvals: NonNullable<TurnResult["pendingApprovals"]>,
    ctx: Omit<SlackApprovalContext, "command" | "reason">,
  ): void;
  postApprovalButtons(
    client: any,
    ctx: Omit<SlackApprovalContext, "command" | "reason" | "approvalChannel">,
    approvals: NonNullable<TurnResult["pendingApprovals"]>,
  ): Promise<void>;
  postAgentRequests(
    client: any,
    ctx: {
      requesterId: string;
      channel: string;
      replyThreadTs?: string;
      threadOnly: boolean;
      kind: SlackConversationKind;
      channelName?: string;
      audience: ActorAssertion[];
      slackIdsByPrincipal?: ReadonlyMap<string, string>;
    },
    requests: readonly AgentRequestDirective[],
  ): Promise<void>;
  registerActions(app: { action(pattern: RegExp, handler: (args: any) => Promise<void>): void }): void;
}

export function createApprovals(deps: {
  core: SlackCoreClient;
  bridge: CoreBridge;
  directory: Directory;
  threads: ReturnType<typeof createThreadTracker>;
  ids: BotIdentity;
}): Approvals {
  const { core, bridge, directory, threads, ids } = deps;
  const { callCore, fetchBlobFromCore, fetchFileArtifactFromCore } = bridge;

  const pendingSlackApprovals = createApprovalRegistry<SlackApprovalContext>();
  const pendingSlackAgentRequests = new Map<string, SlackAgentRequestContext>();

  function rememberSlackApprovals(
    approvals: NonNullable<TurnResult["pendingApprovals"]>,
    ctx: Omit<SlackApprovalContext, "command" | "reason">,
  ): void {
    for (const approval of approvals) {
      pendingSlackApprovals.remember(approval.requestId, {
        ...ctx,
        command: approval.command,
        reason: approval.reason,
        ...(approval.purpose ? { purpose: approval.purpose } : {}),
        ...(approval.summary ? { summary: approval.summary } : {}),
      });
    }
  }

  async function resolveApprovalCardChannel(
    client: any,
    ctx: { channel: string; requesterId: string; threadOnly: boolean },
  ): Promise<{ approvalChannel: string; toDm: boolean; channelPointer: string }> {
    const { toDm, channelPointer } = approvalCardDestination(ctx.threadOnly);
    if (!toDm) return { approvalChannel: ctx.channel, toDm: false, channelPointer };
    try {
      const opened = await client.conversations.open({ users: ctx.requesterId });
      const dm = String(opened?.channel?.id ?? "");
      if (dm) return { approvalChannel: dm, toDm: true, channelPointer };
    } catch (err) {
      console.error("[slack-plugin] couldn't open approval DM:", (err as Error).message);
    }
    return { approvalChannel: ctx.channel, toDm: false, channelPointer: "" };
  }

  async function postApprovalButtons(
    client: any,
    ctx: Omit<SlackApprovalContext, "command" | "reason" | "approvalChannel">,
    approvals: NonNullable<TurnResult["pendingApprovals"]>,
  ): Promise<void> {
    const { approvalChannel, toDm, channelPointer } = await resolveApprovalCardChannel(client, ctx);
    rememberSlackApprovals(approvals, { ...ctx, approvalChannel });
    const msg = approvalMessage(approvals);
    await client.chat.postMessage({
      ...slackReplyArgs(approvalChannel, msg.text, toDm ? undefined : ctx.replyThreadTs, { threadOnly: !toDm }),
      blocks: msg.blocks,
    });
    if (toDm && channelPointer) {
      await client.chat
        .postMessage(slackReplyArgs(ctx.channel, channelPointer, ctx.replyThreadTs, { threadOnly: true }))
        .catch(swallowAs("slack: post approval pointer", undefined));
    }
  }

  type StoredApprovalFetch = { state: "found"; stored: StoredApproval } | { state: "gone" } | { state: "unavailable" };

  async function fetchStoredApproval(requestId: string): Promise<StoredApprovalFetch> {
    try {
      const stored = await core.getApproval(requestId);
      if (!stored) return { state: "gone" };
      return { state: "found", stored: stored as StoredApproval };
    } catch (err) {
      console.error("[slack-plugin] approval recovery fetch failed:", (err as Error).message);
      return { state: "unavailable" };
    }
  }

  function agentRequestStatusText(
    ctx: SlackAgentRequestContext,
    state: "waiting" | "running" | "declined" | "failed",
  ): string {
    const arrow = `*${ctx.originAgentLabel} → ${ctx.targetAgentLabel}*`;
    if (state === "waiting")
      return `${arrow}\nWaiting for ${ctx.targetDisplayName ?? ctx.targetUserId} to approve running this in their personal setup.`;
    if (state === "running") return `${arrow}\nApproved. Running with ${ctx.targetAgentLabel} now.`;
    if (state === "declined")
      return `${arrow}\n${ctx.targetDisplayName ?? ctx.targetUserId} declined the personal-agent handoff.`;
    return `${arrow}\nThe personal-agent handoff could not be completed.`;
  }

  async function failAgentRequest(
    client: any,
    ctx: SlackAgentRequestContext,
    reason: string,
    dmMessageTs?: string,
  ): Promise<void> {
    const originText = `${agentRequestStatusText(ctx, "failed")}\n${reason}`;
    if (!(await tryUpdateSlackMessage(client, ctx.originChannel, ctx.originStatusTs, originText))) {
      await client.chat
        .postMessage(
          slackReplyArgs(ctx.originChannel, originText, ctx.originThreadTs, { threadOnly: ctx.originThreadOnly }),
        )
        .catch((err: Error) => console.error("[slack-plugin] couldn't post handoff failure:", err.message));
    }
    await tryUpdateSlackMessage(
      client,
      ctx.dmChannel,
      dmMessageTs ?? ctx.dmMessageTs,
      `I couldn't finish the handoff: ${reason}`,
    );
  }

  async function completeAgentRequest(
    client: any,
    ctx: SlackAgentRequestContext,
    result: TurnResult,
    dmMessageTs?: string,
  ): Promise<void> {
    const { text: replyBody } = cleanAgentReplyForSlack(result.reply ?? "");
    let bodyText = "Completed.";
    if (replyBody) bodyText = toSlackMrkdwn(replyBody);
    else if (result.attachments?.length) bodyText = "Completed; attached file(s) below.";
    const posted = `*${ctx.targetAgentLabel} → ${ctx.originAgentLabel}*\n${bodyText}`;
    if (!(await tryUpdateSlackMessage(client, ctx.originChannel, ctx.originStatusTs, posted))) {
      await client.chat.postMessage(
        slackReplyArgs(ctx.originChannel, posted, ctx.originThreadTs, {
          threadOnly: ctx.originThreadOnly,
          unfurlLinks: false,
        }),
      );
    }
    if (result.attachments?.length) {
      try {
        await uploadAttachments(
          client,
          ctx.originChannel,
          ctx.originThreadTs,
          result.attachments,
          fetchBlobFromCore,
          fetchFileArtifactFromCore,
        );
      } catch (err) {
        console.error("[slack-plugin] file upload failed:", (err as Error).message);
        await client.chat.postMessage(
          slackReplyArgs(ctx.originChannel, uploadFailureNote(err), ctx.originThreadTs, {
            threadOnly: ctx.originThreadOnly,
          }),
        );
      }
    }
    await tryUpdateSlackMessage(
      client,
      ctx.dmChannel,
      dmMessageTs ?? ctx.dmMessageTs,
      `Posted the result from ${ctx.targetAgentLabel} back to ${ctx.originAgentLabel}.`,
    );
  }

  async function askForAgentRequestCommandApproval(
    client: any,
    ctx: SlackAgentRequestContext,
    turn: Omit<CoreTurnBody, "approval">,
    approvals: NonNullable<TurnResult["pendingApprovals"]>,
    opts: { approvalMessageTs?: string; handoffMessageTs?: string } = {},
  ): Promise<void> {
    if (!approvals.length) {
      await failAgentRequest(
        client,
        ctx,
        `${ctx.targetAgentLabel} asked for command approval but did not return an approval request.`,
        opts.handoffMessageTs,
      );
      return;
    }

    rememberSlackApprovals(approvals, {
      requesterId: ctx.targetUserId,
      channel: ctx.dmChannel,
      approvalChannel: ctx.dmChannel,
      ...(ctx.dmMessageTs ? { triggerTs: ctx.dmMessageTs } : {}),
      threadOnly: false,
      turn,
      agentRequest: ctx,
    });
    const msg = approvalMessage(approvals);
    if (opts.approvalMessageTs) {
      await updateSlackMessage(client, ctx.dmChannel, opts.approvalMessageTs, msg.text, msg.blocks);
    } else {
      await client.chat.postMessage({ ...slackReplyArgs(ctx.dmChannel, msg.text, undefined), blocks: msg.blocks });
    }
    await tryUpdateSlackMessage(
      client,
      ctx.originChannel,
      ctx.originStatusTs,
      `${agentRequestStatusText(ctx, "running")}\nWaiting for ${ctx.targetDisplayName ?? ctx.targetUserId} to approve a command in their personal setup.`,
    );
    await tryUpdateSlackMessage(
      client,
      ctx.dmChannel,
      opts.handoffMessageTs ?? ctx.dmMessageTs,
      `This handoff needs command approval before ${ctx.targetAgentLabel} can finish.`,
    );
  }

  async function handleAgentRequestResult(
    client: any,
    ctx: SlackAgentRequestContext,
    turn: Omit<CoreTurnBody, "approval">,
    result: TurnResult,
    opts: { approvalMessageTs?: string; handoffMessageTs?: string } = {},
  ): Promise<void> {
    const approvals = result.pendingApprovals ?? [];
    if (approvals.length || result.status === "pending_approval") {
      await askForAgentRequestCommandApproval(client, ctx, turn, approvals, opts);
      return;
    }
    if (result.status === "ok") {
      await completeAgentRequest(client, ctx, result, opts.handoffMessageTs ?? opts.approvalMessageTs);
      if (opts.approvalMessageTs && opts.handoffMessageTs && opts.approvalMessageTs !== opts.handoffMessageTs) {
        await tryUpdateSlackMessage(
          client,
          ctx.dmChannel,
          opts.approvalMessageTs,
          `Posted the result from ${ctx.targetAgentLabel} back to ${ctx.originAgentLabel}.`,
        );
      }
      return;
    }
    await failAgentRequest(
      client,
      ctx,
      result.reason ?? result.status,
      opts.handoffMessageTs ?? opts.approvalMessageTs,
    );
  }

  async function postAgentRequests(
    client: any,
    ctx: {
      requesterId: string;
      channel: string;
      replyThreadTs?: string;
      threadOnly: boolean;
      kind: SlackConversationKind;
      channelName?: string;
      audience: ActorAssertion[];
      slackIdsByPrincipal?: ReadonlyMap<string, string>;
    },
    requests: readonly AgentRequestDirective[],
  ): Promise<void> {
    for (const req of requests) {
      const target = resolveAgentRequestTarget(ctx.audience, req.targetUserId, ctx.slackIdsByPrincipal);
      const originAgentLabel = channelAgentLabel(ctx.kind, ctx.channelName, ctx.channel);
      if (!target || target.isExternalGuest) {
        await client.chat.postMessage(
          slackReplyArgs(
            ctx.channel,
            `${originAgentLabel} can only ask personal agents for internal people who are already in this conversation.`,
            ctx.replyThreadTs,
            { threadOnly: ctx.threadOnly },
          ),
        );
        continue;
      }

      if (target.isBot) {
        await client.chat.postMessage(
          slackReplyArgs(
            ctx.channel,
            `${originAgentLabel}: ${target.displayName ?? "that"} is another agent — just @mention it in your reply to reach it; ask-agent is only for a person's private setup.`,
            ctx.replyThreadTs,
            { threadOnly: ctx.threadOnly },
          ),
        );
        continue;
      }

      const requestId = randomUUID();
      const targetAgentLabel = personalAgentLabel(target, req.targetUserId);
      const base: Omit<SlackAgentRequestContext, "originStatusTs" | "dmChannel" | "dmMessageTs"> = {
        requesterId: ctx.requesterId,
        targetUserId: req.targetUserId,
        ...(target.displayName ? { targetDisplayName: target.displayName } : {}),
        originChannel: ctx.channel,
        originConversationKind: ctx.kind,
        ...(ctx.replyThreadTs ? { originThreadTs: ctx.replyThreadTs } : {}),
        originThreadOnly: ctx.threadOnly,
        ...(ctx.channelName ? { originChannelName: ctx.channelName } : {}),
        task: req.task,
        originAgentLabel,
        targetAgentLabel,
      };

      let pendingCtx: SlackAgentRequestContext | undefined;
      try {
        const opened = await client.conversations.open({ users: req.targetUserId });
        const dmChannel = String(opened?.channel?.id ?? "");
        if (!dmChannel) {
          await client.chat.postMessage(
            slackReplyArgs(
              ctx.channel,
              `${originAgentLabel} couldn't open a DM to ${target.displayName ?? req.targetUserId}.`,
              ctx.replyThreadTs,
              {
                threadOnly: ctx.threadOnly,
              },
            ),
          );
          continue;
        }

        pendingCtx = { ...base, dmChannel };
        const status = await client.chat.postMessage(
          slackReplyArgs(ctx.channel, agentRequestStatusText(pendingCtx, "waiting"), ctx.replyThreadTs, {
            threadOnly: ctx.threadOnly,
          }),
        );
        if (status?.ts) pendingCtx.originStatusTs = String(status.ts);

        const prompt = agentRequestMessage({
          requestId,
          originAgentLabel,
          targetAgentLabel,
          task: req.task,
        });
        const dm = await client.chat.postMessage({
          channel: dmChannel,
          text: prompt.text,
          ...botIdentityArgs(),
          blocks: prompt.blocks,
        });
        if (dm?.ts) pendingCtx.dmMessageTs = String(dm.ts);
        pendingSlackAgentRequests.set(requestId, pendingCtx);
      } catch (err) {
        const reason = `Slack couldn't send the personal-agent request to ${target.displayName ?? req.targetUserId}: ${(err as Error).message}`;
        if (pendingCtx?.originStatusTs) {
          await failAgentRequest(client, pendingCtx, reason);
        } else {
          await client.chat.postMessage(
            slackReplyArgs(
              ctx.channel,
              `${originAgentLabel} couldn't ask ${targetAgentLabel}: ${(err as Error).message}`,
              ctx.replyThreadTs,
              {
                threadOnly: ctx.threadOnly,
              },
            ),
          );
        }
      }
    }
  }

  async function postApprovalFollowup(client: any, ctx: SlackApprovalContext, text: string): Promise<void> {
    await client.chat.postMessage(slackReplyArgs(ctx.channel, text, ctx.replyThreadTs, { threadOnly: ctx.threadOnly }));
  }

  function personalAgentTurnText(ctx: SlackAgentRequestContext): string {
    const destination = conversationPlaceLabel(
      ctx.originConversationKind ?? "channel",
      ctx.originChannelName,
      ctx.originChannel,
    );
    return [
      "[Agent-to-agent request]",
      `${ctx.originAgentLabel} asked ${ctx.targetAgentLabel} to help with a task that may require this user's personal setup.`,
      "",
      "Task:",
      ctx.task,
      "",
      `Run this in the user's personal context if appropriate. Do not reveal API keys, credentials, tokens, or other secrets. Return only the concrete outcome, evidence, or blocker that is safe to share back to ${destination}.`,
    ].join("\n");
  }

  async function handleApprovalAction({ ack, body, action, client }: any): Promise<void> {
    await ack();
    const a = action as any;
    const actionId = a.action_id as ApprovalActionId | undefined;
    if (
      actionId !== "hilo_allow_once" &&
      actionId !== "hilo_allow_session" &&
      actionId !== "hilo_allow_always" &&
      actionId !== "hilo_deny"
    ) {
      return;
    }

    const requestId = String(a.value ?? "");
    let ctx = pendingSlackApprovals.get(requestId);
    const clickerId = String((body as any)?.user?.id ?? "");
    const channel = String((body as any)?.channel?.id ?? ctx?.channel ?? "");
    const messageTs = (body as any)?.message?.ts as string | undefined;
    const messageThreadTs = (body as any)?.message?.thread_ts as string | undefined;

    if (!ctx && channel) {
      const fetched = await fetchStoredApproval(requestId);
      if (fetched.state === "unavailable") {
        if (clickerId) {
          await client.chat
            .postEphemeral({
              channel,
              user: clickerId,
              text: "I couldn't check on that approval just now — try the button again in a moment.",
            })
            .catch(swallowAs("slack: chat.postEphemeral", undefined));
        }
        return;
      }
      const rebuilt =
        fetched.state === "found"
          ? recoveredApprovalContext(fetched.stored, {
              channel,
              ...(messageThreadTs ? { threadTs: messageThreadTs } : {}),
            })
          : null;
      if (rebuilt) {
        pendingSlackApprovals.remember(requestId, { ...rebuilt, recovered: true } as SlackApprovalContext);
        ctx = pendingSlackApprovals.get(requestId);
        console.log(`[slack-plugin] recovered approval ${requestId} from core (in-memory context was lost)`);
      }
    }

    if (!ctx) {
      if (channel && messageTs) {
        await updateSlackMessage(
          client,
          channel,
          messageTs,
          "_That approval request expired — let me know when you want to try again._",
        ).catch(swallowAs("slack: update approval message", undefined));
      } else if (channel && clickerId) {
        await client.chat
          .postEphemeral({
            channel,
            user: clickerId,
            text: "That approval request expired — let me know when you want to try again.",
          })
          .catch(swallowAs("slack: chat.postEphemeral", undefined));
      }
      return;
    }

    const requesterMatches = ctx.recovered
      ? (await directory.classifyActor(client, clickerId)).externalId === ctx.requesterId
      : clickerId === ctx.requesterId;
    if (!requesterMatches) {
      await client.chat
        .postEphemeral({
          channel,
          user: clickerId,
          text: "Only the person who requested this command can approve or deny it.",
        })
        .catch(swallowAs("slack: chat.postEphemeral", undefined));
      return;
    }

    const begun = pendingSlackApprovals.begin(requestId);
    if (begun.state === "busy") {
      await client.chat
        .postEphemeral({
          channel,
          user: clickerId,
          text: "Still working on your previous click — give it a moment.",
        })
        .catch(swallowAs("slack: chat.postEphemeral", undefined));
      return;
    }
    if (begun.state !== "ready") return;

    const selected = approvalScope(actionId);
    const approval = {
      requestId,
      approved: selected !== "deny",
      ...(selected !== "deny" ? { scope: selected } : {}),
    };

    let settled = false;
    const settle = (): void => {
      pendingSlackApprovals.settle(requestId);
      settled = true;
    };

    const cardChannel = ctx.approvalChannel;
    const cardIsRemote = cardChannel !== ctx.channel;
    try {
      const approver = await directory.classifyActor(client, clickerId);
      const onQueued =
        messageTs && !cardIsRemote
          ? (runId: string): void => {
              bridge.reportRunEditRef(runId, messageTs);
            }
          : undefined;
      if (selected === "deny") {
        await callCore({ ...ctx.turn, actor: approver, approval }, onQueued ? { onQueued } : {});
        settle();
        await updateSlackMessage(client, cardChannel, messageTs, `Denied ${inlineCode(ctx.command)}.`);
        if (ctx.agentRequest) {
          await failAgentRequest(
            client,
            ctx.agentRequest,
            `${inlineCode(ctx.command)} was denied.`,
            ctx.agentRequest.dmMessageTs,
          );
        }
        return;
      }

      let scopeLabel = "Allowed always";
      if (selected === "once") scopeLabel = "Allowed once";
      else if (selected === "session") scopeLabel = "Allowed for this conversation";
      await updateSlackMessage(client, cardChannel, messageTs, `${scopeLabel}; running ${inlineCode(ctx.command)}...`);
      const result = await callCore({ ...ctx.turn, actor: approver, approval }, onQueued ? { onQueued } : {});
      settle();

      if (ctx.agentRequest) {
        await handleAgentRequestResult(client, ctx.agentRequest, ctx.turn, result, {
          approvalMessageTs: messageTs,
          handoffMessageTs: ctx.agentRequest.dmMessageTs,
        });
        return;
      }

      if (result.status === "ok") {
        if (ctx.threadOnly && ctx.replyThreadTs) threads.mark(ctx.channel, ctx.replyThreadTs, true);
        const cleanedContinuation = cleanAgentReplyForSlack(result.reply ?? "");
        const replyBody = stripAckPrefix(cleanedContinuation.text, ctx.ackedFirstBlock);
        const { reactions, agentRequests } = cleanedContinuation;
        const actionableAgentRequests = ctx.threadOnly ? agentRequests : [];
        let reply = "(no response)";
        if (replyBody) reply = toSlackMrkdwn(replyBody);
        else if (result.attachments?.length || reactions.length || actionableAgentRequests.length) reply = "Done.";
        if (cardIsRemote) {
          await updateSlackMessage(client, cardChannel, messageTs, `Approved; ran ${inlineCode(ctx.command)}.`);
          await postApprovalFollowup(client, ctx, reply);
        } else {
          await updateSlackMessage(client, cardChannel, messageTs, reply);
        }
        if (result.attachments?.length) {
          try {
            await uploadAttachments(
              client,
              ctx.channel,
              ctx.replyThreadTs,
              result.attachments,
              fetchBlobFromCore,
              fetchFileArtifactFromCore,
            );
          } catch (err) {
            console.error("[slack-plugin] file upload failed:", (err as Error).message);
            await postApprovalFollowup(client, ctx, uploadFailureNote(err));
          }
        }
        const { directives } = resolveReactionTargets(reactions, ctx.allowedTs ?? new Set());
        await applyAndLogReactions(client, ctx.channel, ctx.triggerTs, directives);
        if (actionableAgentRequests.length) {
          await postAgentRequests(
            client,
            {
              requesterId: ctx.requesterId,
              channel: ctx.channel,
              ...(ctx.replyThreadTs ? { replyThreadTs: ctx.replyThreadTs } : {}),
              threadOnly: ctx.threadOnly,
              kind: ctx.turn.conversation.kind,
              ...(ctx.turn.conversation.channelName ? { channelName: ctx.turn.conversation.channelName } : {}),
              audience: ctx.turn.conversation.audience ?? [],
              ...(ctx.slackIdsByPrincipal ? { slackIdsByPrincipal: ctx.slackIdsByPrincipal } : {}),
            },
            actionableAgentRequests,
          );
        }
        return;
      }

      if (result.status === "pending_approval") {
        const approvals = result.pendingApprovals ?? [];
        rememberSlackApprovals(approvals, {
          requesterId: ctx.requesterId,
          channel: ctx.channel,
          approvalChannel: cardChannel,
          ...(ctx.replyThreadTs ? { replyThreadTs: ctx.replyThreadTs } : {}),
          ...(ctx.triggerTs ? { triggerTs: ctx.triggerTs } : {}),
          threadOnly: ctx.threadOnly,
          turn: ctx.turn,
          ...(ctx.allowedTs ? { allowedTs: ctx.allowedTs } : {}),
          ...(ctx.slackIdsByPrincipal ? { slackIdsByPrincipal: ctx.slackIdsByPrincipal } : {}),
          ...(ctx.recovered ? { recovered: true } : {}),
        });
        const msg = approvalMessage(approvals);
        await updateSlackMessage(client, cardChannel, messageTs, msg.text, msg.blocks);
        return;
      }

      const failLink = isBoundaryRefusal(result.reason) ? null : (result.adminUrl ?? null);
      const failDetail = failLink ? ` Full error: ${failLink}` : "";
      await updateSlackMessage(
        client,
        cardChannel,
        messageTs,
        `I can't continue — ${result.reason ?? "refused"}.${failDetail}`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (settled) {
        await updateSlackMessage(client, cardChannel, messageTs, `⚠️ ${msg}`).catch(
          swallowAs("slack: update approval message", undefined),
        );
        if (ctx.agentRequest) {
          await failAgentRequest(client, ctx.agentRequest, msg, ctx.agentRequest.dmMessageTs);
        }
        return;
      }
      pendingSlackApprovals.release(requestId);
      const retry = approvalMessage([
        {
          requestId,
          command: ctx.command,
          reason: ctx.reason,
          ...(ctx.purpose ? { purpose: ctx.purpose } : {}),
          ...(ctx.summary ? { summary: ctx.summary } : {}),
        },
      ]);
      await updateSlackMessage(
        client,
        cardChannel,
        messageTs,
        `⚠️ ${clip(msg, 300)} — the approval is still pending; use the buttons to try again.`,
        [
          {
            type: "section",
            text: { type: "mrkdwn", text: `⚠️ ${clip(msg, 300)} — the approval is still pending; try again:` },
          },
          ...retry.blocks,
        ],
      ).catch(swallowAs("slack: update approval message", undefined));
    }
  }

  async function handleAgentRequestAction({ ack, body, action, client }: any): Promise<void> {
    await ack();
    const a = action as any;
    const actionId = a.action_id as AgentRequestActionId | undefined;
    if (actionId !== "agent_request_run" && actionId !== "agent_request_deny") return;

    const requestId = String(a.value ?? "");
    const ctx = pendingSlackAgentRequests.get(requestId);
    const clickerId = String((body as any)?.user?.id ?? "");
    const channel = String((body as any)?.channel?.id ?? ctx?.dmChannel ?? "");
    const messageTs = (body as any)?.message?.ts as string | undefined;

    if (!ctx) {
      if (channel && messageTs) {
        await updateSlackMessage(
          client,
          channel,
          messageTs,
          "_That agent request expired — ask the channel agent to send it again._",
        ).catch(swallowAs("slack: update agent-request message", undefined));
      } else if (channel && clickerId) {
        await client.chat
          .postEphemeral({
            channel,
            user: clickerId,
            text: "That agent request expired — ask the channel agent to send it again.",
          })
          .catch(swallowAs("slack: chat.postEphemeral", undefined));
      }
      return;
    }

    if (clickerId !== ctx.targetUserId) {
      await client.chat
        .postEphemeral({
          channel: ctx.dmChannel,
          user: clickerId,
          text: "Only the person whose personal agent was asked can approve or decline this request.",
        })
        .catch(swallowAs("slack: chat.postEphemeral", undefined));
      return;
    }

    pendingSlackAgentRequests.delete(requestId);
    const decision = agentRequestAction(actionId);
    if (decision === "deny") {
      await updateSlackMessage(
        client,
        ctx.dmChannel,
        messageTs ?? ctx.dmMessageTs,
        `Declined. I won't run this in ${ctx.targetAgentLabel}.`,
      );
      await updateSlackMessage(client, ctx.originChannel, ctx.originStatusTs, agentRequestStatusText(ctx, "declined"));
      return;
    }

    await updateSlackMessage(
      client,
      ctx.dmChannel,
      messageTs ?? ctx.dmMessageTs,
      `Approved. Running with ${ctx.targetAgentLabel} now...`,
    );
    await updateSlackMessage(client, ctx.originChannel, ctx.originStatusTs, agentRequestStatusText(ctx, "running"));

    try {
      const classified = await directory.classifyUserCached(client, ctx.targetUserId);
      const actor = classified.actor;
      if (actor.isExternalGuest) throw new Error("the target user is not internal");
      const personalTurn: Omit<CoreTurnBody, "approval"> = {
        actor,
        conversation: {
          kind: "dm",
          threadRef: dmThreadRef(ctx.dmChannel),
          audience: [actor],
        },
        deliveryTarget: encodeDeliveryTarget(ctx.dmChannel),
        text: personalAgentTurnText(ctx),
        gatewayContext: {
          location: `an agent-to-agent handoff in a direct message with ${actor.displayName ?? ctx.targetUserId}`,
          details: {
            channel: ctx.dmChannel,
            requested_by_channel: ctx.originChannel,
            ...(ctx.originThreadTs ? { requested_by_thread_ts: ctx.originThreadTs } : {}),
          },
          instructions:
            "You are answering an agent-to-agent handoff. Work only with this user's personal context and return a concise result safe to share back to the originating Slack thread.",
          ...(ids.botHandle ? { botHandle: ids.botHandle } : {}),
        },
        ...(classified.timezone ? { timezone: classified.timezone } : {}),
      };
      const result = await callCore(personalTurn);
      await handleAgentRequestResult(client, ctx, personalTurn, result, {
        handoffMessageTs: messageTs ?? ctx.dmMessageTs,
      });
    } catch (err) {
      const msg = (err as Error).message;
      await failAgentRequest(client, ctx, msg, messageTs ?? ctx.dmMessageTs);
    }
  }

  function registerActions(app: { action(pattern: RegExp, handler: (args: any) => Promise<void>): void }): void {
    app.action(/^hilo_/, handleApprovalAction);
    app.action(/^agent_request_/, handleAgentRequestAction);
  }

  return { rememberSlackApprovals, postApprovalButtons, postAgentRequests, registerActions };
}
