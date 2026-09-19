import type { DeliveryHandler, DeliveryTaskContext } from "../delivery/task-delivery.ts";
import type { Delivery } from "../types.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import { dmThreadRef } from "./message-gating.ts";
import { cronIdOf } from "../sessions/session-store.ts";
import {
  botIdentityArgs,
  deliveryMetadata,
  findPostedByKey,
  openConversationFor,
  parseDeliveryTarget,
  postWithVerify,
  recoveryVerifyOldest,
  slackReplyArgs,
} from "./delivery.ts";
import { approvalMessage, recoveredApprovalContext } from "./approval-cards.ts";
import { uploadDurableAttachment } from "./attachments.ts";
import { cleanAgentReplyForSlack, stripSlackDirectives } from "./messaging.ts";
import { renderTaskList } from "./presenters.ts";
import { slackSectionBlocks, toSlackMrkdwn } from "./mrkdwn.ts";
import { slackErrorCode } from "./payloads.ts";
import { normalizeReactions, resolveReactionTargets } from "./reactions.ts";
import { assertOperationActive } from "../util/async.ts";
import type { Approvals } from "./approvals.ts";

export function createSlackDeliveryHandler(deps: {
  core: SlackCoreClient;
  client: any;
  clientForIdentity(identity: string): any;
  webUiPublicUrl?: string;
  threads: { mark(channel: string, ts: string, replied: boolean): void };
  approvals?: Approvals;
}): DeliveryHandler {
  async function post(
    context: DeliveryTaskContext,
    delivery: Delivery,
    client: any,
    key: string,
    args: Parameters<typeof postWithVerify>[1],
  ) {
    return context.step(key, () =>
      postWithVerify(client, args, key, {
        context,
        verifyFirst: true,
        verifyOldest: recoveryVerifyOldest(delivery.createdAt, delivery.destination.editRef),
      }),
    );
  }

  return async (delivery, context) => {
    let { destination } = delivery;
    const key = delivery.idempotencyKey;
    const runId = key.startsWith("run:") ? key.slice(4) : undefined;
    const run = runId ? await deps.core.getDeliveryRun?.(runId) : null;
    const savedContext = run?.request.slackDeliveryContext;
    const agentRequest = savedContext?.agentRequestId
      ? await context.step("agent-request:context", () => deps.core.getAgentRequest(savedContext.agentRequestId!))
      : null;
    const pendingApproval = Boolean(destination.approvalRequestIds?.length);
    if (agentRequest && pendingApproval)
      await context.step("agent-request:approvals", async () => {
        await deps.core.putAgentRequest(agentRequest.requestId, {
          ...agentRequest,
          approvalRequestIds: destination.approvalRequestIds,
        });
        return true;
      });
    if (agentRequest && !pendingApproval)
      destination = {
        ...destination,
        target: agentRequest.originThreadTs
          ? `${agentRequest.originChannel}:${agentRequest.originThreadTs}`
          : agentRequest.originChannel,
        editRef: agentRequest.originStatusTs,
      };
    const client = destination.identity ? deps.clientForIdentity(destination.identity) : deps.client;
    const target =
      destination.type === "principal"
        ? await context.step("destination", async () => ({
            channel: await openConversationFor(client, [destination.target]),
            ...(destination.threadTs ? { threadTs: destination.threadTs } : {}),
          }))
        : parseDeliveryTarget(destination.target);
    const { channel, threadTs } = target;
    const withMessageLock = <T>(execute: () => Promise<T>) =>
      runId && deps.core.withRunDeliveryLock ? deps.core.withRunDeliveryLock(runId, execute) : execute();
    const resolveProgressRef = async () => {
      if (!run || agentRequest || run.request.surfaceTools || destination.editRef) return;
      const current = await deps.core.getDeliveryRun?.(run.id);
      const editRef =
        current?.deliveryState?.editRef ??
        (
          await findPostedByKey(
            client,
            { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
            `run:${run.id}:progress`,
            String((run.createdAt - 60_000) / 1000),
          )
        )?.ts;
      if (editRef) destination = { ...destination, editRef };
    };
    const mutate = async (name: string, execute: () => Promise<unknown>, accepted: readonly string[]) =>
      context.step(name, async () => {
        try {
          await execute();
        } catch (error) {
          if (!accepted.includes(slackErrorCode(error) ?? "")) throw error;
        }
        return true;
      });
    if (destination.react) {
      await mutate(
        "reaction",
        () =>
          client.reactions.add({ channel, timestamp: destination.react!.messageTs, name: destination.react!.emoji }),
        ["already_reacted"],
      );
      return;
    }
    if (destination.delete) {
      await mutate("delete", () => client.chat.delete({ channel, ts: destination.delete!.messageTs }), [
        "message_not_found",
      ]);
      return;
    }
    if (destination.pin) {
      await mutate(
        "pin",
        () =>
          client.pins[destination.pin!.remove ? "remove" : "add"]({ channel, timestamp: destination.pin!.messageTs }),
        ["already_pinned", "no_pin", "not_pinned"],
      );
      return;
    }
    const cleaned = cleanAgentReplyForSlack(delivery.text);
    let replyText = runId ? cleaned.text : stripSlackDirectives(delivery.text);
    if (agentRequest && !pendingApproval) {
      const fallback = run?.request.approval?.approved === false ? "The requested command was denied." : "Completed.";
      replyText = `*${agentRequest.targetAgentLabel} → ${agentRequest.originAgentLabel}*\n${cleaned.text || fallback}`;
    }
    const text = toSlackMrkdwn(replyText);
    const footer: Array<Record<string, unknown>> = [];
    if (destination.relaySender)
      footer.push({
        type: "plain_text",
        text: `Sent for @${destination.relaySender.replace(/^@+/, "")}`,
        emoji: false,
      });
    const cronId = delivery.provenance?.trigger === "cron" ? cronIdOf(delivery.provenance.sourceThreadRef) : null;
    if (cronId && deps.webUiPublicUrl) {
      const title = (delivery.provenance?.sourceTitle?.trim() || "Cron")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      footer.push({
        type: "mrkdwn",
        text: `${title} · <${deps.webUiPublicUrl.replace(/\/+$/, "")}/crons/${encodeURIComponent(cronId)}|Settings>`,
        verbatim: true,
      });
    }
    if (destination.debugFooter) footer.push({ type: "mrkdwn", text: destination.debugFooter });
    const taskList = destination.taskList?.length ? renderTaskList(destination.taskList) : "";
    const blocks =
      taskList || footer.length
        ? [
            ...(text.trim() ? slackSectionBlocks(text) : []),
            ...(taskList ? slackSectionBlocks(taskList) : []),
            ...(footer.length ? [{ type: "context", elements: footer }] : []),
          ]
        : undefined;
    let root = threadTs;
    if (text.trim() || taskList || (footer.length && delivery.attachments?.length)) {
      const posted = await context.step("message", () =>
        withMessageLock(async () => {
          await resolveProgressRef();
          assertOperationActive();
          if (destination.editRef) {
            try {
              await client.chat.update({
                channel,
                ts: destination.editRef,
                text: text || taskList,
                blocks: blocks ?? slackSectionBlocks(text),
                metadata: deliveryMetadata(key),
                ...botIdentityArgs(),
              });
              return { channel, ts: destination.editRef };
            } catch (error) {
              if (!["message_not_found", "cant_update_message"].includes(slackErrorCode(error) ?? "")) throw error;
            }
          }
          return postWithVerify(
            client,
            {
              ...slackReplyArgs(channel, text || taskList, threadTs, {
                unfurlLinks: runId ? false : destination.unfurlLinks,
              }),
              ...(blocks ? { blocks } : {}),
            },
            key,
            {
              context,
              verifyFirst: true,
              verifyOldest: recoveryVerifyOldest(delivery.createdAt, destination.editRef),
            },
          );
        }),
      );
      root ??= posted.ts;
    } else if (destination.editRef || runId) {
      await context.step("progress:remove", () =>
        withMessageLock(async () => {
          await resolveProgressRef();
          assertOperationActive();
          if (destination.editRef) {
            try {
              await client.chat.delete({ channel, ts: destination.editRef });
            } catch (error) {
              if (slackErrorCode(error) !== "message_not_found") throw error;
            }
          }
          return true;
        }),
      );
    }
    for (const [index, attachment] of (delivery.attachments ?? []).entries()) {
      const uploaded = await uploadDurableAttachment(
        context,
        `attachment:${index}`,
        client,
        channel,
        root,
        attachment,
        deps.core,
      );
      root ??= uploaded.messageTs;
    }
    for (const requestId of destination.approvalRequestIds ?? []) {
      const stored = await deps.core.getApproval(requestId);
      if (!stored) continue;
      const approval = recoveredApprovalContext(stored, { channel, ...(threadTs ? { threadTs } : {}) });
      if (!approval) throw new Error(`Approval ${requestId} has no durable delivery context`);
      const approvalChannel = approval.threadOnly
        ? await context.step(`approval:${requestId}:destination`, () =>
            openConversationFor(client, [approval.requesterId]),
          )
        : channel;
      const card = approvalMessage([{ ...stored, reason: stored.reason ?? "requires approval" }]);
      await post(context, delivery, client, `approval:${requestId}:card`, {
        ...slackReplyArgs(approvalChannel, card.text, approvalChannel === channel ? threadTs : undefined),
        blocks: card.blocks,
      });
      if (approvalChannel !== channel)
        await post(context, delivery, client, `approval:${requestId}:pointer`, {
          ...slackReplyArgs(channel, "I sent you an approval request in a DM.", threadTs, { threadOnly: true }),
        });
    }
    if (runId) {
      if (run) {
        const origin = run.request.origin;
        let triggerTs = savedContext?.triggerTs;
        if (!triggerTs && origin && "messageTs" in origin) triggerTs = origin.messageTs;
        if (!triggerTs && origin && "entryTs" in origin) triggerTs = origin.entryTs;
        const allowed = new Set<string>([...(savedContext?.allowedTs ?? []), ...(triggerTs ? [triggerTs] : [])]);
        const { directives } = resolveReactionTargets(cleaned.reactions, allowed);
        for (const [index, directive] of directives.entries()) {
          const ts = directive.target ?? triggerTs;
          if (!ts) continue;
          for (const emoji of normalizeReactions(directive.names))
            await mutate(
              `reaction:${index}:${emoji}`,
              () => client.reactions.add({ channel, timestamp: ts, name: emoji }),
              ["already_reacted"],
            );
        }
        for (const emoji of normalizeReactions(run.result?.reactions ?? []))
          if (triggerTs)
            await mutate(
              `reaction:result:${emoji}`,
              () => client.reactions.add({ channel, timestamp: triggerTs, name: emoji }),
              ["already_reacted"],
            );
        if (cleaned.agentRequests.length && deps.approvals && run.request.conversation.kind !== "dm") {
          await deps.approvals.postAgentRequests(
            client,
            {
              requesterId: savedContext?.requesterId ?? run.request.actor.id,
              channel,
              ...(threadTs ? { replyThreadTs: threadTs } : {}),
              threadOnly: true,
              kind: run.request.conversation.kind,
              channelName: run.request.conversation.channelName,
              audience:
                savedContext?.audience ??
                run.request.conversation.audience.map((actor) => ({
                  externalId: actor.id,
                  displayName: actor.displayName,
                  isExternalGuest: actor.type === "guest",
                })),
              ...(savedContext?.slackIdsByPrincipal
                ? { slackIdsByPrincipal: new Map(savedContext.slackIdsByPrincipal) }
                : {}),
            },
            cleaned.agentRequests,
            { context, key },
          );
        }
      }
      await context.step("task-ack:finish", async () => {
        await deps.core.taskAcknowledgements?.finish(client, runId);
        return true;
      });
    }
    const approvalCard = savedContext?.approvalCard;
    if (approvalCard && approvalCard.channel !== channel) {
      let status = "Approved; the result is posted in the original conversation.";
      if (pendingApproval) status = "Another approval is needed.";
      if (run?.request.approval?.approved === false) status = "Denied.";
      await mutate(
        "approval:decision",
        () =>
          client.chat.update({
            channel: approvalCard.channel,
            ts: approvalCard.messageTs,
            text: status,
            blocks: slackSectionBlocks(status),
            ...botIdentityArgs(),
          }),
        ["message_not_found"],
      );
    }
    if (agentRequest && !pendingApproval) {
      const status = `Posted the result from ${agentRequest.targetAgentLabel} back to ${agentRequest.originAgentLabel}.`;
      if (agentRequest.dmMessageTs)
        await mutate(
          "agent-request:status",
          () =>
            client.chat.update({
              channel: agentRequest.dmChannel,
              ts: agentRequest.dmMessageTs,
              text: status,
              blocks: slackSectionBlocks(status),
              ...botIdentityArgs(),
            }),
          ["message_not_found"],
        );
      await context.step("agent-request:settle", async () => {
        await deps.core.takeAgentRequest(agentRequest.requestId);
        return true;
      });
    }
    if (root) deps.threads.mark(channel, root, true);
    if (destination.type === "principal")
      await context.step("principal:thread", async () => {
        await deps.core.recordPrincipalDelivery?.(delivery.id, dmThreadRef(channel, threadTs));
        return true;
      });
  };
}
