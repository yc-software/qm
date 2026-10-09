import { randomUUID } from "node:crypto";
import { samePerson } from "../directory/person.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { userFacingFailureClause } from "../core/failure-copy.ts";
import { GENERIC_FAILURE_CLAUSE } from "../../plugins/chassis/src/failure-copy.ts";
import type { SlackAgentRequestContext, SlackCoreClient } from "../api/slack-core-client.ts";
import type { TurnResult } from "../types.ts";
import type { Approvals } from "./approvals.ts";
import { button } from "./approval-cards.ts";
import { uploadAttachments, uploadFailureNote } from "./attachments.ts";
import { encodeDeliveryTarget, parseDeliveryTarget } from "./delivery.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import { botIdentityArgs, dmThreadRef, slackReplyArgs, toSlackMrkdwn } from "./lib.ts";
import {
  channelAgentLabel,
  cleanAgentReplyForSlack,
  conversationPlaceLabel,
  personalAgentLabel,
  tryUpdateSlackMessage,
  updateSlackMessage,
} from "./messaging.ts";
import { parseBlockAction, parseInteractionBody } from "./payloads.ts";
import { slackFailureClause, type CoreTurnBody } from "./turn-flow.ts";

const AGENT_REQUEST_ACTION_IDS = ["agent_request_run", "agent_request_deny"] as const;
export type AgentRequestActionId = (typeof AGENT_REQUEST_ACTION_IDS)[number];

export interface SlackAgentRequest {
  requestId: string;
  originAgentLabel: string;
  targetAgentLabel: string;
  task: string;
}

export interface SlackAgentRequestMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

const AGENT_REQUEST_BLOCK_PREFIX = "agent_request:";

function truncateForSlack(text: string, max = 900): string {
  const safe = text.replace(/\s+/g, " ").trim();
  return `${safe.slice(0, max)}${safe.length > max ? "..." : ""}`;
}

export function agentRequestMessage(req: SlackAgentRequest): SlackAgentRequestMessage {
  const task = truncateForSlack(req.task);
  return {
    text: `${req.originAgentLabel} is asking ${req.targetAgentLabel} to run a personal-scope task.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${req.originAgentLabel} → ${req.targetAgentLabel}*\n${task}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "This runs in your personal agent context. The result can be posted back to the original thread.",
          },
        ],
      },
      {
        type: "actions",
        block_id: `${AGENT_REQUEST_BLOCK_PREFIX}${req.requestId}`.slice(0, 255),
        elements: [
          button("Run with my setup", "agent_request_run", req.requestId, "primary"),
          button("Decline", "agent_request_deny", req.requestId, "danger"),
        ],
      },
    ],
  };
}

export type AskAgentOutcome = { handoff: { requestId: string; target: string } } | { error: string };

interface TurnOutcome {
  result: TurnResult;
  runId?: string;
}

interface ActionArgs {
  ack: () => Promise<void>;
  body: unknown;
  action: unknown;
  client: any;
}

function agentRequestAction(actionId: AgentRequestActionId): "run" | "deny" {
  return actionId === "agent_request_run" ? "run" : "deny";
}

export function createAgentHandoffs(deps: {
  externalAccess?: boolean;
  core: SlackCoreClient;
  directory: Directory;
  ids: BotIdentity;
  runTurn: (body: CoreTurnBody) => Promise<TurnOutcome>;
  ackConveyedQuarantine: (outcome: TurnOutcome) => void;
  rememberSlackApprovals: Approvals["rememberSlackApprovals"];
}) {
  const { core, directory, ids, runTurn, ackConveyedQuarantine, rememberSlackApprovals } = deps;

  type AgentRequestFetch =
    { state: "found"; ctx: SlackAgentRequestContext } | { state: "gone" } | { state: "unavailable" };

  async function fetchAgentRequest(requestId: string): Promise<AgentRequestFetch> {
    try {
      const ctx = await core.getAgentRequest(requestId);
      if (!ctx) return { state: "gone" };
      return { state: "found", ctx };
    } catch (err) {
      console.error("[slack-plugin] agent-request recovery fetch failed:", (err as Error).message);
      return { state: "unavailable" };
    }
  }

  async function settleAgentRequest(ctx: SlackAgentRequestContext): Promise<void> {
    await core.takeAgentRequest(ctx.requestId).catch(swallowAs("slack: settle agent request", null));
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
    await settleAgentRequest(ctx);
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
    await settleAgentRequest(ctx);
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
        await uploadAttachments(client, ctx.originChannel, ctx.originThreadTs, result.attachments, core);
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

    const linked: SlackAgentRequestContext = { ...ctx, approvalRequestIds: approvals.map((p) => p.requestId) };
    try {
      await core.putAgentRequest(linked.requestId, linked);
    } catch (err) {
      swallow("slack: putAgentRequest", err);
      await failAgentRequest(
        client,
        ctx,
        `the pending command approval couldn't be recorded — ${GENERIC_FAILURE_CLAUSE}`,
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
      agentRequest: linked,
    });
    if (opts.approvalMessageTs)
      await updateSlackMessage(
        client,
        ctx.dmChannel,
        opts.approvalMessageTs,
        "Approved. A new command needs approval; its card will arrive separately.",
      );
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
      userFacingFailureClause(result),
      opts.handoffMessageTs ?? opts.approvalMessageTs,
    );
  }

  async function askFromRun(
    client: any,
    ask: { runId: string; targetUserId: string; task: string },
  ): Promise<AskAgentOutcome> {
    const run = await core.getAgentRequestRun(ask.runId);
    if (!run) return { error: "this turn is no longer running, so there is no conversation to report back to" };
    const { request } = run;
    if (
      deps.externalAccess ||
      request.externalSlack ||
      request.surface !== "slack" ||
      request.conversation.kind !== "channel"
    )
      return { error: "asking a personal agent works only from an internal Slack channel" };
    const task = ask.task.trim();
    if (!request.deliveryTarget || !task) return { error: "a task and a Slack thread to report back to are required" };
    const { channel, threadTs } = parseDeliveryTarget(request.deliveryTarget);
    const originAgentLabel = channelAgentLabel("channel", request.conversation.channelName, channel);
    const target = await directory.classifyActor(client, ask.targetUserId);
    if (target.isBot)
      return {
        error: `${target.displayName ?? ask.targetUserId} is an agent — @mention it in this conversation instead`,
      };
    const member = request.conversation.audience.find((p) => samePerson(p.id, target.externalId));
    if (!member || member.type !== "internal" || target.isExternalGuest)
      return { error: "you can only ask the personal agent of an internal person who is already in this conversation" };

    const requestId = randomUUID();
    const targetAgentLabel = personalAgentLabel(target, ask.targetUserId);
    const opened = await client.conversations.open({ users: ask.targetUserId });
    const dmChannel = String(opened?.channel?.id ?? "");
    if (!dmChannel) return { error: `couldn't open a DM to ${target.displayName ?? ask.targetUserId}` };
    const pendingCtx: SlackAgentRequestContext = {
      requestId,
      createdAt: Date.now(),
      requesterId: request.actor.id,
      targetUserId: ask.targetUserId,
      ...(target.displayName ? { targetDisplayName: target.displayName } : {}),
      originChannel: channel,
      originConversationKind: "channel",
      ...(threadTs ? { originThreadTs: threadTs } : {}),
      originThreadOnly: true,
      ...(request.conversation.channelName ? { originChannelName: request.conversation.channelName } : {}),
      task,
      originAgentLabel,
      targetAgentLabel,
      dmChannel,
    };
    try {
      const prompt = agentRequestMessage({ requestId, originAgentLabel, targetAgentLabel, task });
      const dm = await client.chat.postMessage({
        channel: dmChannel,
        text: prompt.text,
        ...botIdentityArgs(),
        blocks: prompt.blocks,
      });
      if (!dm?.ts) throw new Error("Slack did not confirm the DM");
      pendingCtx.dmMessageTs = String(dm.ts);
      const status = await client.chat.postMessage(
        slackReplyArgs(channel, agentRequestStatusText(pendingCtx, "waiting"), threadTs, { threadOnly: true }),
      );
      if (status?.ts) pendingCtx.originStatusTs = String(status.ts);
      await core.putAgentRequest(requestId, pendingCtx);
    } catch (err) {
      swallow("slack: agent request dispatch", err);
      const withdrawn = "This request couldn't be recorded, so it was withdrawn.";
      await tryUpdateSlackMessage(client, dmChannel, pendingCtx.dmMessageTs, withdrawn);
      await tryUpdateSlackMessage(client, channel, pendingCtx.originStatusTs, withdrawn);
      return { error: `couldn't send the request to ${target.displayName ?? ask.targetUserId}: ${errMessage(err)}` };
    }
    return { handoff: { requestId, target: targetAgentLabel } };
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

  async function handleAgentRequestAction({ ack, body, action, client }: ActionArgs): Promise<void> {
    await ack();
    if (deps.externalAccess) return;
    const parsed = parseBlockAction(action, AGENT_REQUEST_ACTION_IDS);
    if (!parsed) return;
    const { actionId, value: requestId } = parsed;

    const click = parseInteractionBody(body);
    const { clickerId, messageTs } = click;
    const fetched = await fetchAgentRequest(requestId);
    const channel = click.channel ?? (fetched.state === "found" ? fetched.ctx.dmChannel : "");

    if (fetched.state === "unavailable") {
      if (channel && clickerId) {
        await client.chat
          .postEphemeral({
            channel,
            user: clickerId,
            text: "I couldn't check on that agent request just now — try the button again in a moment.",
          })
          .catch(swallowAs("slack: chat.postEphemeral", undefined));
      }
      return;
    }

    if (fetched.state === "gone") {
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

    if (clickerId !== fetched.ctx.targetUserId) {
      await client.chat
        .postEphemeral({
          channel: fetched.ctx.dmChannel,
          user: clickerId,
          text: "Only the person whose personal agent was asked can approve or decline this request.",
        })
        .catch(swallowAs("slack: chat.postEphemeral", undefined));
      return;
    }

    let claimed: SlackAgentRequestContext | null | undefined;
    try {
      claimed = await core.takeAgentRequest(requestId);
    } catch (err) {
      console.error("[slack-plugin] agent-request claim failed:", (err as Error).message);
    }
    if (claimed === undefined) {
      await client.chat
        .postEphemeral({
          channel: fetched.ctx.dmChannel,
          user: clickerId,
          text: "I couldn't check on that agent request just now — try the button again in a moment.",
        })
        .catch(swallowAs("slack: chat.postEphemeral", undefined));
      return;
    }
    if (!claimed) return;
    const decision = agentRequestAction(actionId);
    const ctx = decision === "run" ? { ...claimed, requestId: randomUUID() } : claimed;
    if (decision === "deny") {
      await tryUpdateSlackMessage(
        client,
        ctx.dmChannel,
        messageTs ?? ctx.dmMessageTs,
        `Declined. I won't run this in ${ctx.targetAgentLabel}.`,
      );
      await tryUpdateSlackMessage(
        client,
        ctx.originChannel,
        ctx.originStatusTs,
        agentRequestStatusText(ctx, "declined"),
      );
      return;
    }

    try {
      await updateSlackMessage(
        client,
        ctx.dmChannel,
        messageTs ?? ctx.dmMessageTs,
        `Approved. Running with ${ctx.targetAgentLabel} now...`,
      );
      await updateSlackMessage(client, ctx.originChannel, ctx.originStatusTs, agentRequestStatusText(ctx, "running"));
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
            agent_request_id: ctx.requestId,
            ...(ctx.originThreadTs ? { requested_by_thread_ts: ctx.originThreadTs } : {}),
          },
          instructions:
            "You are answering an agent-to-agent handoff. Work only with this user's personal context and return a concise result safe to share back to the originating Slack thread.",
          ...(ids.botHandle ? { botHandle: ids.botHandle } : {}),
        },
        ...(classified.timezone ? { timezone: classified.timezone } : {}),
      };
      await core.putAgentRequest(ctx.requestId, ctx);
      const outcome = await runTurn(personalTurn);
      await handleAgentRequestResult(client, ctx, personalTurn, outcome.result, {
        handoffMessageTs: messageTs ?? ctx.dmMessageTs,
      });
      ackConveyedQuarantine(outcome);
    } catch (err) {
      console.error("[slack-plugin] agent-request action failed:", errMessage(err));
      await failAgentRequest(client, ctx, slackFailureClause(err), messageTs ?? ctx.dmMessageTs);
    }
  }

  return {
    askFromRun,
    fail: failAgentRequest,
    handleResult: handleAgentRequestResult,
    handleAction: handleAgentRequestAction,
  };
}

export type AgentHandoffs = ReturnType<typeof createAgentHandoffs>;
