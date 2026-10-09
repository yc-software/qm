import { isSubagentThreadRef } from "../sessions/session-syscalls.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { slackFailureClause, slackFailureText } from "./turn-flow.ts";
import {
  APPROVAL_ACTION_IDS,
  type ApprovalActionId,
  type StoredApproval,
  approvalMessage,
  clip,
  createApprovalRegistry,
  createThreadTracker,
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
import { parseBlockAction, parseInteractionBody } from "./payloads.ts";
import type { SlackAgentRequestContext, SlackCoreClient } from "../api/slack-core-client.ts";
import { type AgentHandoffs, createAgentHandoffs } from "./agent-requests.ts";
import type { TurnResult } from "../types.ts";
import { userFacingFailureClause } from "../core/failure-copy.ts";
import type { CoreTurnBody, TurnFlow } from "./turn-flow.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import { applyAndLogReactions, cleanAgentReplyForSlack, updateSlackMessage } from "./messaging.ts";

interface ActionArgs {
  ack: () => Promise<void>;
  body: unknown;
  action: unknown;
  client: any;
}

interface SlackApprovalContext {
  requesterId: string | undefined;
  channel: string;
  replyThreadTs?: string;
  triggerTs?: string;
  threadOnly: boolean;
  approvalChannel: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  turn: Omit<CoreTurnBody, "approval">;
  allowedTs?: Set<string>;
  slackIdsByPrincipal?: ReadonlyMap<string, string>;
  agentRequest?: SlackAgentRequestContext;
  ackedFirstBlock?: string;
  recovered?: boolean;
}

type ApprovalScope = "once" | "session" | "always";

function approvalScope(actionId: ApprovalActionId): ApprovalScope | "deny" {
  if (actionId === "hilo_allow_once") return "once";
  if (actionId === "hilo_allow_session") return "session";
  if (actionId === "hilo_allow_always") return "always";
  return "deny";
}

export interface Approvals {
  rememberSlackApprovals(
    approvals: NonNullable<TurnResult["pendingApprovals"]>,
    ctx: Omit<SlackApprovalContext, "command" | "reason">,
  ): void;
  handoffs: AgentHandoffs;
  registerActions(app: { action(pattern: RegExp, handler: (args: any) => Promise<void>): void }): void;
}

export function createApprovals(deps: {
  externalAccess?: boolean;
  core: SlackCoreClient;
  flow: TurnFlow;
  directory: Directory;
  threads: ReturnType<typeof createThreadTracker>;
  ids: BotIdentity;
}): Approvals {
  const { core, flow, directory, threads, ids } = deps;

  interface TurnOutcome {
    result: TurnResult;
    runId?: string;
  }

  async function runTurn(body: CoreTurnBody, hooks: { onQueued?: (runId: string) => void } = {}): Promise<TurnOutcome> {
    if (deps.externalAccess && body.conversation.kind !== "dm")
      throw new Error("Continue this request privately instead of resuming a shared approval.");
    let runId: string | undefined;
    const result = await flow.callCore(body, {
      ...hooks,
      onQueued: (id) => {
        runId = id;
        hooks.onQueued?.(id);
      },
    });
    return { result, ...(runId ? { runId } : {}) };
  }

  function ackConveyedQuarantine({ result, runId }: TurnOutcome): void {
    if (runId && result.status === "refused" && result.refusalKind === "security_quarantine") {
      flow.ackRunDelivery(runId);
    }
  }

  const pendingSlackApprovals = createApprovalRegistry<SlackApprovalContext>();

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
        ...(approval.kind ? { kind: approval.kind } : {}),
        ...(approval.grantModes ? { grantModes: approval.grantModes } : {}),
      });
    }
  }

  const handoffs = createAgentHandoffs({
    core,
    directory,
    ids,
    ...(deps.externalAccess ? { externalAccess: true } : {}),
    runTurn,
    ackConveyedQuarantine,
    rememberSlackApprovals,
  });

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

  async function postApprovalFollowup(client: any, ctx: SlackApprovalContext, text: string): Promise<void> {
    await client.chat.postMessage(slackReplyArgs(ctx.channel, text, ctx.replyThreadTs, { threadOnly: ctx.threadOnly }));
  }

  async function handleApprovalAction({ ack, body, action, client }: ActionArgs): Promise<void> {
    await ack();
    const parsed = parseBlockAction(action, APPROVAL_ACTION_IDS);
    if (!parsed) return;
    const { actionId, value: requestId } = parsed;

    let ctx = pendingSlackApprovals.get(requestId);
    const click = parseInteractionBody(body);
    const { clickerId, messageTs, messageThreadTs } = click;
    const channel = click.channel ?? ctx?.channel ?? "";

    if (pendingSlackApprovals.busy(requestId)) {
      if (channel && clickerId) {
        await client.chat
          .postEphemeral({
            channel,
            user: clickerId,
            text: "This approval is being resolved right now — give it a moment.",
          })
          .catch(swallowAs("slack: chat.postEphemeral", undefined));
      }
      return;
    }

    const fetched = channel ? await fetchStoredApproval(requestId) : ({ state: "unavailable" } as const);
    if (fetched.state === "unavailable" && !ctx) {
      if (channel && clickerId) {
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
    if (fetched.state === "gone") {
      pendingSlackApprovals.settle(requestId);
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
    const rebuilt =
      fetched.state === "found"
        ? recoveredApprovalContext(fetched.stored, {
            channel,
            ...(messageThreadTs ? { threadTs: messageThreadTs } : {}),
          })
        : null;
    if (rebuilt && !ctx) {
      const handoffId = (rebuilt.turn.gatewayContext as CoreTurnBody["gatewayContext"])?.details?.agent_request_id;
      const handoff = await (
        typeof handoffId === "string" ? core.getAgentRequest(handoffId) : core.agentRequestForApproval(requestId)
      ).catch(swallowAs("slack: agent-request recovery", null));
      pendingSlackApprovals.remember(requestId, {
        ...rebuilt,
        ...(handoff ? { agentRequest: handoff } : {}),
        recovered: true,
      } as SlackApprovalContext);
      ctx = pendingSlackApprovals.get(requestId);
      console.log(`[slack-plugin] recovered approval ${requestId} from core (in-memory context was lost)`);
    } else if (rebuilt && ctx) {
      ctx = {
        ...ctx,
        requesterId: rebuilt.requesterId,
        turn: rebuilt.turn as SlackApprovalContext["turn"],
        ...(rebuilt.kind ? { kind: rebuilt.kind } : {}),
        ...(rebuilt.grantModes ? { grantModes: rebuilt.grantModes } : {}),
        recovered: true,
      };
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

    const requesterMatches =
      clickerId === ctx.requesterId ||
      (ctx.recovered === true && (await directory.classifyActor(client, clickerId)).externalId === ctx.requesterId);
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

    const delegated = isSubagentThreadRef(ctx.turn.conversation.threadRef);
    const cardChannel = ctx.approvalChannel;
    const cardIsRemote = cardChannel !== ctx.channel;
    try {
      const approver = await directory.classifyActor(client, clickerId);
      const onQueued =
        messageTs && !cardIsRemote && !delegated
          ? (runId: string): void => {
              void core
                .reportRunEditRef(runId, messageTs)
                .catch(swallowAs("slack: delivery-state checkpoint", undefined));
            }
          : undefined;
      const sealedOut = async (result: TurnResult): Promise<boolean> => {
        const retained = result.pendingApprovals?.find((item) => item.requestId === requestId);
        if (result.status !== "pending_approval" || (result.pendingApprovals?.length && !retained)) return false;
        pendingSlackApprovals.remember(requestId, ctx);
        const note = result.reason ?? "This conversation is waiting on a pending approval.";
        const retry = approvalMessage([
          {
            requestId,
            command: ctx.command,
            reason: ctx.reason,
            ...(ctx.purpose ? { purpose: ctx.purpose } : {}),
            ...(ctx.summary ? { summary: ctx.summary } : {}),
            ...(ctx.kind ? { kind: ctx.kind } : {}),
            ...(ctx.grantModes ? { grantModes: ctx.grantModes } : {}),
            ...retained,
          },
        ]);
        await updateSlackMessage(
          client,
          cardChannel,
          messageTs,
          `${note} This approval stays pending; try again once the conversation is unblocked.`,
          [{ type: "section", text: { type: "mrkdwn", text: note } }, ...retry.blocks],
        ).catch(swallowAs("slack: update approval message", undefined));
        return true;
      };

      if (selected === "deny") {
        const outcome = await runTurn({ ...ctx.turn, actor: approver, approval }, onQueued ? { onQueued } : {});
        settle();
        if (await sealedOut(outcome.result)) return;
        await updateSlackMessage(client, cardChannel, messageTs, `Denied ${inlineCode(ctx.command)}.`);
        if (ctx.agentRequest) {
          await handoffs.fail(
            client,
            ctx.agentRequest,
            `${inlineCode(ctx.command)} was denied.`,
            ctx.agentRequest.dmMessageTs,
          );
        }
        ackConveyedQuarantine(outcome);
        return;
      }

      let scopeLabel = "Allowed always";
      if (selected === "once") scopeLabel = "Allowed once";
      else if (selected === "session") scopeLabel = "Allowed for this conversation";
      await updateSlackMessage(client, cardChannel, messageTs, `${scopeLabel}; running ${inlineCode(ctx.command)}...`);
      const outcome = await runTurn({ ...ctx.turn, actor: approver, approval }, onQueued ? { onQueued } : {});
      const result = outcome.result;
      settle();

      if (await sealedOut(result)) return;

      if (delegated) {
        await updateSlackMessage(
          client,
          cardChannel,
          messageTs,
          result.status === "failed" || result.status === "refused"
            ? `Approved; the delegated task could not continue: ${result.reason ?? "execution failed"}`
            : `Approved ${inlineCode(ctx.command)}. Results will return to the original conversation.`,
        );
        return;
      }

      if (ctx.agentRequest) {
        await handoffs.handleResult(client, ctx.agentRequest, ctx.turn, result, {
          approvalMessageTs: messageTs,
          handoffMessageTs: ctx.agentRequest.dmMessageTs,
        });
        ackConveyedQuarantine(outcome);
        return;
      }

      if (result.status === "ok") {
        if (ctx.threadOnly && ctx.replyThreadTs) threads.mark(ctx.channel, ctx.replyThreadTs, true);
        const cleanedContinuation = cleanAgentReplyForSlack(result.reply ?? "");
        const replyBody = stripAckPrefix(cleanedContinuation.text, ctx.ackedFirstBlock);
        const { reactions } = cleanedContinuation;
        let reply = result.stopped ? "Stopped." : "(no response)";
        if (replyBody) reply = toSlackMrkdwn(replyBody);
        else if (result.attachments?.length || reactions.length) reply = "Done.";
        if (cardIsRemote) {
          await updateSlackMessage(client, cardChannel, messageTs, `Approved; ran ${inlineCode(ctx.command)}.`);
          await postApprovalFollowup(client, ctx, reply);
        } else {
          await updateSlackMessage(client, cardChannel, messageTs, reply);
        }
        if (result.attachments?.length) {
          try {
            await uploadAttachments(client, ctx.channel, ctx.replyThreadTs, result.attachments, core);
          } catch (err) {
            console.error("[slack-plugin] file upload failed:", (err as Error).message);
            await postApprovalFollowup(client, ctx, uploadFailureNote(err));
          }
        }
        const { directives } = resolveReactionTargets(reactions, ctx.allowedTs ?? new Set());
        await applyAndLogReactions(client, ctx.channel, ctx.triggerTs, directives);
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
        await updateSlackMessage(
          client,
          cardChannel,
          messageTs,
          "Approved. A new command needs approval; its card will arrive separately.",
        );
        return;
      }

      const failLink = isBoundaryRefusal(result.reason) ? null : (result.adminUrl ?? null);
      const failDetail = failLink ? ` Full error: ${failLink}` : "";
      await updateSlackMessage(
        client,
        cardChannel,
        messageTs,
        `I can't continue — ${userFacingFailureClause(result)}.${failDetail}`,
      );
      ackConveyedQuarantine(outcome);
    } catch (err) {
      console.error("%s", `[slack] approval ${requestId} action failed:`, errMessage(err));
      const msg = slackFailureText(err);
      if (settled) {
        await updateSlackMessage(client, cardChannel, messageTs, `⚠️ ${msg}`).catch(
          swallowAs("slack: update approval message", undefined),
        );
        if (ctx.agentRequest) {
          await handoffs.fail(client, ctx.agentRequest, slackFailureClause(err), ctx.agentRequest.dmMessageTs);
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
          ...(ctx.kind ? { kind: ctx.kind } : {}),
          ...(ctx.grantModes ? { grantModes: ctx.grantModes } : {}),
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

  function registerActions(app: { action(pattern: RegExp, handler: (args: any) => Promise<void>): void }): void {
    app.action(/^hilo_/, handleApprovalAction);
    app.action(/^agent_request_/, handoffs.handleAction);
  }

  return { rememberSlackApprovals, handoffs, registerActions };
}
