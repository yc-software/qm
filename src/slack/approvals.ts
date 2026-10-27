import { isSubagentThreadRef } from "../sessions/thread-ref.ts";
import { reportFailure, swallowAs } from "../util/errors.ts";
import { slackFailureText } from "./turn-flow.ts";
import { slackSectionBlocks, toSlackMrkdwn } from "./mrkdwn.ts";
import {
  APPROVAL_ACTION_IDS,
  type PendingApproval,
  type StoredApproval,
  approvalDecisionMessage,
  approvalDetails,
  approvalMessage,
  type ApprovalDecisionRecord,
  createApprovalRegistry,
  recoveredApprovalContext,
} from "./approval-cards.ts";
import { safeClip } from "./safe-cut.ts";
import { createThreadTracker } from "./message-gating.ts";
import { resolveReactionTargets } from "./reactions.ts";
import { slackReplyArgs } from "./delivery.ts";
import { stripAckPrefix } from "./presenters.ts";
import { uploadAttachments, uploadFailureNote } from "./attachments.ts";
import { parseBlockAction, parseInteractionBody } from "./payloads.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { TurnResult } from "../types.ts";
import { userFacingFailureClause } from "../core/failure-copy.ts";
import type { CoreTurnBody, TurnFlow } from "./turn-flow.ts";
import type { Directory } from "./directory.ts";
import { type ActionApp, applyAndLogReactions, cleanAgentReplyForSlack, updateSlackMessage } from "./messaging.ts";

interface SlackApprovalContext extends Omit<PendingApproval, "requestId" | "originUrl"> {
  requesterId: string | undefined;
  channel: string;
  replyThreadTs?: string;
  triggerTs?: string;
  threadOnly: boolean;
  approvalChannel: string;
  turn: Omit<CoreTurnBody, "approval">;
  allowedTs?: Set<string>;
  slackIdsByPrincipal?: ReadonlyMap<string, string>;
  ackedFirstBlock?: string;
  recovered?: boolean;
}

const SCOPES = {
  hilo_allow_once: "once",
  hilo_allow_session: "session",
  hilo_allow_always: "always",
  hilo_deny: "deny",
} as const;

const EXPIRED = "That approval request expired — let me know when you want to try again.";

type ApprovalDeps = {
  externalAccess?: boolean;
  core: SlackCoreClient;
  flow: TurnFlow;
  directory: Directory;
  threads: ReturnType<typeof createThreadTracker>;
};

type ApprovalRuntime = ApprovalDeps & {
  pendingSlackApprovals: ReturnType<typeof createApprovalRegistry<SlackApprovalContext>>;
  rememberSlackApprovals: (
    approvals: NonNullable<TurnResult["pendingApprovals"]>,
    ctx: Omit<SlackApprovalContext, "command" | "reason">,
  ) => void;
};

interface ApprovalClick {
  client: any;
  requestId: string;
  actionId: keyof typeof SCOPES;
  clickerId: string;
  messageTs: string | undefined;
  channel: string;
  ctx: SlackApprovalContext;
}

export function createApprovals(deps: ApprovalDeps) {
  const pendingSlackApprovals = createApprovalRegistry<SlackApprovalContext>();
  function rememberSlackApprovals(
    approvals: NonNullable<TurnResult["pendingApprovals"]>,
    ctx: Omit<SlackApprovalContext, "command" | "reason">,
  ): void {
    for (const approval of approvals)
      pendingSlackApprovals.remember(approval.requestId, {
        ...ctx,
        command: approval.command,
        reason: approval.reason,
        ...approvalDetails(approval),
      });
  }

  const rt: ApprovalRuntime = { ...deps, pendingSlackApprovals, rememberSlackApprovals };
  return {
    rememberSlackApprovals,
    registerActions(app: ActionApp): void {
      app.action(/^hilo_/, (args: any) => handleApprovalAction(rt, args));
    },
  };
}

async function runTurn(deps: ApprovalDeps, body: CoreTurnBody, onQueued?: (runId: string) => void) {
  if (deps.externalAccess && body.conversation.kind !== "dm")
    throw new Error("Continue this request privately instead of resuming a shared approval.");
  let runId: string | undefined;
  const result = await deps.flow.callCore(body, {
    onQueued: (id) => {
      runId = id;
      onQueued?.(id);
    },
  });
  const ackQuarantine = (): void => {
    if (runId && result.status === "refused" && result.refusalKind === "security_quarantine")
      deps.flow.ackRunDelivery(runId);
  };
  return { result, ackQuarantine };
}

async function fetchStoredApproval(
  core: SlackCoreClient,
  requestId: string,
): Promise<StoredApproval | null | "unavailable"> {
  try {
    return ((await core.getApproval(requestId)) as StoredApproval | null) ?? null;
  } catch (err) {
    reportFailure("slack: approval recovery fetch", err, requestId);
    return "unavailable";
  }
}

async function handleApprovalAction(rt: ApprovalRuntime, { ack, body, action, client }: any): Promise<void> {
  await ack();
  const parsed = parseBlockAction(action, APPROVAL_ACTION_IDS);
  if (!parsed) return;
  const click = await claimApproval(rt, client, parsed.actionId, parsed.value, parseInteractionBody(body));
  if (click) await settleApproval(rt, click);
}

async function claimApproval(
  rt: ApprovalRuntime,
  client: any,
  actionId: keyof typeof SCOPES,
  requestId: string,
  click: ReturnType<typeof parseInteractionBody>,
): Promise<ApprovalClick | undefined> {
  const { pendingSlackApprovals, directory } = rt;
  let ctx = pendingSlackApprovals.get(requestId);
  const { clickerId, messageTs, messageThreadTs } = click;
  const channel = click.channel ?? ctx?.channel ?? "";
  const tell = (text: string): Promise<unknown> =>
    client.chat
      .postEphemeral({ channel, user: clickerId, text })
      .catch(swallowAs("slack: chat.postEphemeral", undefined));
  const expire = async (): Promise<void> => {
    if (channel && messageTs)
      await updateSlackMessage(client, channel, messageTs, `_${EXPIRED}_`).catch(
        swallowAs("slack: update approval message", undefined),
      );
    else if (channel && clickerId) await tell(EXPIRED);
  };

  if (pendingSlackApprovals.busy(requestId)) {
    if (channel && clickerId) await tell("This approval is being resolved right now — give it a moment.");
    return;
  }

  const fetched = channel ? await fetchStoredApproval(rt.core, requestId) : "unavailable";
  if (fetched === "unavailable" && !ctx) {
    if (channel && clickerId)
      await tell("I couldn't check on that approval just now — try the button again in a moment.");
    return;
  }
  if (fetched === null) {
    pendingSlackApprovals.settle(requestId);
    await expire();
    return undefined;
  }
  const rebuilt =
    fetched !== "unavailable"
      ? recoveredApprovalContext(fetched, { channel, ...(messageThreadTs ? { threadTs: messageThreadTs } : {}) })
      : null;
  if (rebuilt && !ctx) {
    pendingSlackApprovals.remember(requestId, { ...rebuilt, recovered: true } as SlackApprovalContext);
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
    await expire();
    return undefined;
  }

  const requesterMatches =
    clickerId === ctx.requesterId ||
    (ctx.recovered === true && (await directory.classifyActor(client, clickerId)).externalId === ctx.requesterId);
  if (!requesterMatches) {
    await tell("Only the person who requested this command can approve or deny it.");
    return;
  }

  const begun = pendingSlackApprovals.begin(requestId);
  if (begun.state === "busy") {
    await tell("Still working on your previous click — give it a moment.");
    return;
  }
  if (begun.state !== "ready") return;

  return { client, requestId, actionId, clickerId, messageTs, channel, ctx };
}

async function settleApproval(rt: ApprovalRuntime, click: ApprovalClick): Promise<void> {
  const { core, directory, pendingSlackApprovals, threads } = rt;
  const { client, requestId, actionId, clickerId, messageTs, ctx } = click;
  const selected = SCOPES[actionId];
  const approval = { requestId, approved: selected !== "deny", ...(selected !== "deny" ? { scope: selected } : {}) };
  let settled = false;
  const delegated = isSubagentThreadRef(ctx.turn.conversation.threadRef);
  const cardChannel = ctx.approvalChannel;
  const cardIsRemote = cardChannel !== ctx.channel;
  const decided: ApprovalDecisionRecord = { decision: selected, by: clickerId, at: Date.now(), state: "done" };
  const updateCard = (text: string, blocks?: Array<Record<string, unknown>>) =>
    updateSlackMessage(client, cardChannel, messageTs, text, blocks);
  const decide = (extra: string[] = []) => {
    const card = approvalDecisionMessage(ctx, decided, extra);
    return updateCard(card.text, card.blocks);
  };
  const pendingCard = (lead: string, text: string, retained = {}) =>
    updateCard(text, [
      { type: "section", text: { type: "mrkdwn", text: lead } },
      ...approvalMessage([
        { requestId, command: ctx.command, reason: ctx.reason, ...approvalDetails(ctx), ...retained },
      ]).blocks,
    ]).catch(swallowAs("slack: update approval message", undefined));
  const followup = (text: string) =>
    client.chat.postMessage(slackReplyArgs(ctx.channel, text, ctx.replyThreadTs, { threadOnly: ctx.threadOnly }));

  const pending = approvalDecisionMessage(ctx, { ...decided, state: "pending" });
  await updateCard(pending.text, pending.blocks).catch(swallowAs("slack: update approval message", undefined));
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
    const { result, ackQuarantine } = await runTurn(rt, { ...ctx.turn, actor: approver, approval }, onQueued);
    pendingSlackApprovals.settle(requestId);
    settled = true;

    const retained = result.pendingApprovals?.find((item) => item.requestId === requestId);
    if (result.status === "pending_approval" && (!result.pendingApprovals?.length || retained)) {
      pendingSlackApprovals.remember(requestId, ctx);
      const note = result.reason ?? "This conversation is waiting on a pending approval.";
      await pendingCard(
        note,
        `${note} This approval stays pending; try again once the conversation is unblocked.`,
        retained,
      );
      return;
    }

    if (delegated) {
      await decide([
        result.status === "failed" || result.status === "refused"
          ? `The delegated task could not continue: ${result.reason ?? "execution failed"}`
          : "Results will return to the original conversation.",
      ]);
      return;
    }

    if (result.status === "ok") {
      if (ctx.threadOnly && ctx.replyThreadTs) threads.mark(ctx.channel, ctx.replyThreadTs, true);
      const cleaned = cleanAgentReplyForSlack(result.reply ?? "");
      const replyBody = stripAckPrefix(cleaned.text, ctx.ackedFirstBlock);
      let reply = result.stopped ? "Stopped." : "(no response)";
      if (replyBody) reply = toSlackMrkdwn(replyBody);
      else if (result.attachments?.length || cleaned.reactions.length) reply = "Done.";
      if (cardIsRemote) {
        await decide();
        await followup(reply);
      } else {
        const replyBlocks = slackSectionBlocks(reply);
        await updateCard(
          reply,
          replyBlocks.length < 48 ? [...replyBlocks, ...approvalDecisionMessage(ctx, decided).blocks] : undefined,
        );
      }
      if (result.attachments?.length) {
        try {
          await uploadAttachments(client, ctx.channel, ctx.replyThreadTs, result.attachments, core);
        } catch (err) {
          reportFailure("slack: approval reply file upload", err);
          await followup(uploadFailureNote(err));
        }
      }
      const { directives } = resolveReactionTargets(cleaned.reactions, ctx.allowedTs ?? new Set());
      await applyAndLogReactions(client, ctx.channel, ctx.triggerTs, directives);
      return;
    }

    if (result.status === "pending_approval") {
      const {
        command: _command,
        reason: _reason,
        purpose: _purpose,
        summary: _summary,
        kind: _kind,
        grantModes: _grantModes,
        ackedFirstBlock: _ackedFirstBlock,
        ...base
      } = ctx;
      rt.rememberSlackApprovals(result.pendingApprovals ?? [], base);
      await decide(["A new command needs approval; its card will arrive separately."]);
      return;
    }

    const failLink = result.refusalKind === "internal_only" ? null : (result.adminUrl ?? null);
    await decide([
      `I can't continue — ${userFacingFailureClause(result)}.${failLink ? ` Full error: ${failLink}` : ""}`,
    ]);
    ackQuarantine();
  } catch (err) {
    reportFailure("slack: approval action", err, requestId);
    const msg = slackFailureText(err);
    if (settled) {
      await updateCard(`⚠️ ${msg}`).catch(swallowAs("slack: update approval message", undefined));
      return;
    }
    pendingSlackApprovals.release(requestId);
    await pendingCard(
      `⚠️ ${safeClip(msg, 300)} — the approval is still pending; try again:`,
      `⚠️ ${safeClip(msg, 300)} — the approval is still pending; use the buttons to try again.`,
    );
  }
}
