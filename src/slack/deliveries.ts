import { extractPrivateContinuation } from "./external-access.ts";
import { deployAccessMessage } from "./deploy-access.ts";
import { approvalDeliveryKey } from "../surfaces/approval-cards.ts";
import { samePerson } from "../directory/person.ts";
import { approvalDeliveryRecipient, approvalMessage, type ApprovalRequester } from "./approval-cards.ts";
import { deliverKeychainCard } from "./keychain-approvals.ts";
import { errMessage, errText, swallow, swallowAs } from "../util/errors.ts";
import { performance } from "node:perf_hooks";
import {
  botIdentityArgs,
  originContext,
  slackPersonaReplyArgs,
  createDeliveryTracker,
  createThreadTracker,
  deliverWithRetry,
  deliveryMetadata,
  dmThreadRef,
  openConversationFor,
  findPostedByKey,
  parseDeliveryTarget,
  statusPlaceholderKey,
  postWithVerify,
  recoveryVerifyOldest,
  slackReplyArgs,
  slackSectionBlocks,
  plainContext,
  blocksWithContext,
  stripReactionDirectives,
  toSlackMrkdwn,
  uploadAttachments,
  uploadFailureNote,
  applyReactions,
} from "./lib.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { Delivery } from "../types.ts";
import { liveRunHoldsDelivery, runDeliveryId, type TurnFlow } from "../surfaces/turn-flow.ts";
import { cleanAgentReplyForSlack, stripSlackDirectives } from "./messaging.ts";
import { cronIdOf } from "../sessions/session-store.ts";
import { slackErrorCode } from "./payloads.ts";
import { trimTrailingSlashes } from "../util/text.ts";
import { SLACK_DELIVERY_CLAIM_MS } from "./delivery-jobs.ts";
import { slackRetryAfterMs } from "./delivery.ts";
import type { SlackStatusCard } from "./session-status.ts";

const PERMANENT_POST_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "account_inactive",
  "user_not_found",
  "cannot_reply_to_message",
  "message_not_found",
]);

const TERMINAL_POST_ERRORS = new Set([
  "cannot_dm_bot",
  "cant_update_message",
  "edit_window_closed",
  "edit_target_not_found",
]);

const SETTLED_PIN_ERRORS = new Set(["already_pinned", "no_pin", "not_pinned"]);

const STATUS_PLACEHOLDER_LOOKBACK_MS = 6 * 3_600_000;

function mergeSlackApiMs(body: unknown, slackApiMs: number | undefined): unknown {
  if (slackApiMs === undefined) return body;
  if (body == null) return { slackApiMs };
  if (typeof body === "object") return { ...(body as object), slackApiMs };
  return body;
}

function throwIfRateLimited(err: unknown): void {
  if (slackRetryAfterMs(err) !== undefined) throw err;
}

function swallowUnlessRateLimited(label: string): (err: unknown) => undefined {
  return (err) => {
    throwIfRateLimited(err);
    return swallowAs(label, undefined)(err);
  };
}

export function createSlackDeliverer(deps: {
  clientForAccount?: (accountId: string, teamId?: string) => any;
  externalNamespace?: (accountId: string) => string | undefined;
  continuePrivate?: (runId: string, task: string) => Promise<void>;
  core: SlackCoreClient;
  webUiPublicUrl?: string;
  flow: TurnFlow;
  threads: ReturnType<typeof createThreadTracker>;
  clientForIdentity(identity: string): any;
  card?: (channel: string, threadTs: string) => SlackStatusCard | undefined;
}): { deliver(client: any, d: Delivery): Promise<void> } {
  const { core, flow, threads, clientForIdentity } = deps;
  const recoveredRow = (d: Delivery): boolean =>
    typeof d.createdAt === "number" && Date.now() - d.createdAt > SLACK_DELIVERY_CLAIM_MS;
  const { inFlightRuns } = flow;

  const ackDelivery = (id: string, body?: unknown): Promise<void> =>
    core.ackDelivery(id, body as { recipientThreadRef?: string; slackApiMs?: number; messageTs?: string } | undefined);

  function deliveryFooter(d: Delivery): Array<Record<string, unknown>> {
    const p = d.provenance;
    let source: { page: "crons" | "webhooks"; id: string; title?: string } | undefined;
    const cronId = p?.trigger === "cron" ? cronIdOf(p.sourceThreadRef) : null;
    if (cronId) source = { page: "crons", id: cronId, title: p?.sourceTitle };
    else if (p?.trigger === "webhook" && p.sourceId)
      source = { page: "webhooks", id: p.sourceId, title: p.sourceTitle };
    const sender = d.destination.relaySender?.trim().replace(/^@+/, "");
    const attribution = [
      ...(sender ? [plainContext(`Sent for @${sender}`)] : []),
      ...(d.destination.editNote ? [plainContext(d.destination.editNote)] : []),
    ];
    const origin = originContext({
      persona: d.destination.persona,
      project: d.destination.project,
      webUiPublicUrl: deps.webUiPublicUrl,
      ...(source ? { source } : {}),
    });
    return origin ? [...attribution, origin] : attribution;
  }

  const deliveryTracker = createDeliveryTracker();
  const undeliverableReported = new Set<string>();

  const logDeliveryError =
    (id: string) =>
    (stage: "post" | "ack", err: unknown, gaveUp: boolean): void => {
      const code = slackErrorCode(err);
      if (stage === "post" && code && TERMINAL_POST_ERRORS.has(code)) {
        deliveryTracker.clear(id);
        console.error(
          `[slack-plugin] delivery ${id} post refused permanently (${code}) — failing it, no retry:`,
          errMessage(err),
        );
        void core.failDelivery(id, code).catch(swallowAs("slack-plugin: fail delivery", undefined));
        return;
      }
      if (stage === "post" && gaveUp && code && PERMANENT_POST_ERRORS.has(code) && !undeliverableReported.has(id)) {
        if (undeliverableReported.size >= 5000) undeliverableReported.clear();
        undeliverableReported.add(id);
        void core
          .reportDeliveryUndeliverable?.(id, code)
          .catch(swallowAs("slack-plugin: undeliverable report", undefined));
      }
      console.error(`[slack-plugin] delivery ${id} ${stage} failed${gaveUp ? " (giving up)" : ""}:`, errMessage(err));
    };

  function deliveryClient(defaultClient: any, destination: Delivery["destination"]): any {
    const account = destination.account;
    if (deps.clientForAccount) return deps.clientForAccount(account?.id ?? "default", account?.workspace);
    return account ? undefined : defaultClient;
  }

  async function deliverToConversation(defaultClient: any, d: Delivery): Promise<void> {
    const destinationClient = deliveryClient(defaultClient, d.destination);
    if (!destinationClient) return;
    const client = destinationClient;
    const runId = runDeliveryId(d);
    const account = d.destination.account;
    const namespace = deps.externalNamespace?.(account?.id ?? "default");
    if (
      namespace &&
      (parseDeliveryTarget(d.destination.target).channel.startsWith("D")
        ? runId && account?.policyNamespace !== namespace
        : !d.provenance?.sourceThreadRef.startsWith(`${namespace}:`))
    ) {
      await ackDelivery(d.id);
      return;
    }
    if (liveRunHoldsDelivery(inFlightRuns, d)) return;
    let slackApiMs: number | undefined;
    await deliverWithRetry({
      tracker: deliveryTracker,
      id: d.id,
      post: async () => {
        const tPost = performance.now();
        try {
          const continuation = extractPrivateContinuation(d.text);
          if (
            runId &&
            continuation.task &&
            d.provenance?.sourceThreadRef.startsWith("external-slack:") &&
            deps.continuePrivate
          ) {
            await deps.continuePrivate(runId, continuation.task);
            return undefined;
          }
          const postClient = d.destination.identity ? clientForIdentity(d.destination.identity) : client;
          const { channel, threadTs } = parseDeliveryTarget(d.destination.target);
          if (d.destination.keychainAskId) {
            await deliverKeychainCard(core, client, d, channel, threadTs, deps.webUiPublicUrl);
            return undefined;
          }
          if (d.destination.react) {
            const { messageTs, emoji } = d.destination.react;
            const { failed } = await applyReactions(client, channel, messageTs, [emoji]);
            if (failed.length)
              console.error(
                `[slack-plugin] delivery ${d.id} reaction(s) failed: ${failed.join(", ")} (check reactions:write / message ts)`,
              );
            return undefined;
          }
          if (d.destination.pin) {
            const { messageTs, remove } = d.destination.pin;
            try {
              if (remove) await client.pins.remove({ channel, timestamp: messageTs });
              else await client.pins.add({ channel, timestamp: messageTs });
            } catch (err) {
              throwIfRateLimited(err);
              const code = slackErrorCode(err);
              if (!code || !SETTLED_PIN_ERRORS.has(code))
                console.error(
                  `[slack-plugin] delivery ${d.id} native ${remove ? "unpin" : "pin"} failed: ${code ?? errMessage(err)}`,
                );
            }
            return undefined;
          }
          if (d.destination.delete) {
            const { messageTs } = d.destination.delete;
            try {
              await client.chat.delete({ channel, ts: messageTs });
            } catch (err) {
              throwIfRateLimited(err);
              const code = slackErrorCode(err);
              if (code !== "message_not_found")
                console.error(
                  `[slack-plugin] delivery ${d.id} delete failed: ${code ?? errMessage(err)} (own messages only)`,
                );
            }
            return undefined;
          }
          if (d.destination.edit) {
            const text = toSlackMrkdwn(stripSlackDirectives(d.text));
            if (!text.trim()) {
              console.error(`[slack-plugin] delivery ${d.id} edit skipped: no text left to write`);
              return undefined;
            }
            const footer = [
              ...deliveryFooter(d),
              ...(d.destination.debugFooter ? [{ type: "mrkdwn", text: d.destination.debugFooter }] : []),
            ];
            const unfurlLinks = d.destination.unfurlLinks;
            if (threadTs) await deps.card?.(channel, threadTs)?.release(d.destination.edit.messageTs);
            await client.chat
              .update({
                channel,
                ts: d.destination.edit.messageTs,
                text,
                blocks: [
                  ...slackSectionBlocks(text),
                  ...(footer.length ? [{ type: "context", elements: footer }] : []),
                ],
                ...botIdentityArgs(d.destination.persona),
                ...(unfurlLinks !== undefined ? { unfurl_links: unfurlLinks, unfurl_media: unfurlLinks } : {}),
              })
              .catch((err: unknown) => {
                if (slackErrorCode(err) !== "message_not_found") throw err;
                throw Object.assign(new Error(`edit target not found: ${errText(err)}`, { cause: err }), {
                  data: { error: "edit_target_not_found" },
                });
              });
            return { messageTs: d.destination.edit.messageTs };
          }
          let editRef = d.destination.editRef;
          if (!editRef && runId) {
            const placeholder = await findPostedByKey(
              client,
              { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
              statusPlaceholderKey(runId),
              String((d.createdAt - STATUS_PLACEHOLDER_LOOKBACK_MS) / 1000),
            ).catch(swallowUnlessRateLimited("slack: status-placeholder probe"));
            if (placeholder) {
              await core.reportRunEditRef(runId, placeholder.ts);
              editRef = placeholder.ts;
            }
          }
          let text = toSlackMrkdwn(runId ? cleanAgentReplyForSlack(d.text).text : stripSlackDirectives(d.text));
          const replayAttachments = async (root?: string): Promise<void> => {
            if (!d.attachments?.length) return;
            try {
              await uploadAttachments(client, channel, root, d.attachments, core);
            } catch (err) {
              throwIfRateLimited(err);
              console.error("%s", `[slack-plugin] delivery ${d.id} attachment upload failed:`, errMessage(err));
              await client.chat
                .postMessage(
                  slackPersonaReplyArgs(channel, uploadFailureNote(err), root, {
                    persona: d.destination.persona,
                    webUiPublicUrl: deps.webUiPublicUrl,
                  }),
                )
                .catch(swallowAs("slack: post upload-failure note", undefined));
            }
          };
          const messageFooter = deliveryFooter(d);
          if (!text.trim() && !messageFooter.length && d.attachments?.length) text = "Files attached.";
          const footer = [
            ...messageFooter,
            ...(d.destination.debugFooter ? [{ type: "mrkdwn", text: d.destination.debugFooter }] : []),
          ];
          const footerBlocks = footer.length ? blocksWithContext(text, footer) : undefined;
          if (!text.trim() && !(messageFooter.length && d.attachments?.length)) {
            if (editRef) {
              await client.chat
                .delete({ channel, ts: editRef })
                .catch(swallowUnlessRateLimited("slack: delete status placeholder"));
            }
            await replayAttachments(threadTs);
            if (d.attachments?.length && threadTs) threads.mark(channel, threadTs, true);
            return undefined;
          }
          const verifyOldest = recoveryVerifyOldest(typeof d.createdAt === "number" ? d.createdAt : undefined, editRef);
          const deliveredMarker = (): Promise<{ ts: string; channel: string } | undefined> =>
            findPostedByKey(
              postClient,
              { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
              d.idempotencyKey ?? d.id,
              verifyOldest ?? String(Date.now() / 1000 - 60),
            ).catch(swallowUnlessRateLimited("slack: delivered-marker probe"));
          if (editRef) {
            const unfurlLinks = runId ? false : d.destination.unfurlLinks;
            try {
              const alreadyDelivered = d.attachments?.length ? await deliveredMarker() : undefined;
              if (threadTs) await deps.card?.(channel, threadTs)?.release(editRef);
              await client.chat.update({
                channel,
                ts: editRef,
                text,
                ...(footerBlocks ? { blocks: footerBlocks } : {}),
                ...botIdentityArgs(d.destination.persona),
                metadata: deliveryMetadata(d.idempotencyKey ?? d.id),
                ...(unfurlLinks !== undefined ? { unfurl_links: unfurlLinks, unfurl_media: unfurlLinks } : {}),
              });
              if (threadTs) threads.mark(channel, threadTs, true);
              if (!alreadyDelivered) await replayAttachments(threadTs);
              return { messageTs: editRef };
            } catch (e) {
              throwIfRateLimited(e);
              swallow("slack: finalize recovered reply in place", e);
            }
          }
          const res = await postWithVerify(
            postClient,
            {
              ...slackReplyArgs(channel, text, threadTs, {
                unfurlLinks: runId ? false : d.destination.unfurlLinks,
                persona: d.destination.persona,
              }),
              ...(footerBlocks ? { blocks: footerBlocks } : {}),
            },
            d.idempotencyKey ?? d.id,
            runId || recoveredRow(d) ? { verifyFirst: true, ...(verifyOldest ? { verifyOldest } : {}) } : undefined,
          );
          const root = threadTs ?? (res?.ts ? String(res.ts) : undefined);
          if (root) threads.mark(channel, root, true);
          const by = d.provenance?.sourceRunId;
          if (by && threadTs && res.ts && !res.parts)
            void deps
              .card?.(channel, threadTs)
              ?.posted({ text, ...(footerBlocks ? { blocks: footerBlocks } : {}) }, res.ts, by);
          if (!res.reused) await replayAttachments(root);
          return res.ts === undefined ? undefined : { messageTs: String(res.ts) };
        } finally {
          slackApiMs = Math.round(performance.now() - tPost);
        }
      },
      ack: async (body) => {
        const acked = await ackDelivery(d.id, mergeSlackApiMs(body, slackApiMs));
        if (runId) await core.taskAcknowledgements?.finish(client, runId);
        return acked;
      },
      onError: logDeliveryError(d.id),
    });
  }

  async function deliverToPrincipal(defaultClient: any, d: Delivery): Promise<void> {
    const client = deliveryClient(defaultClient, d.destination);
    if (!client) return;
    let slackApiMs: number | undefined;
    await deliverWithRetry({
      tracker: deliveryTracker,
      id: d.id,
      post: async () => {
        const tPost = performance.now();
        try {
          if (d.destination.keychainAskId) {
            const dm = await openConversationFor(client, [d.destination.target]);
            await deliverKeychainCard(core, client, d, dm, d.destination.threadTs, deps.webUiPublicUrl);
            return undefined;
          }
          const commandApproval = d.destination.commandApprovalId
            ? await core.getApproval(d.destination.commandApprovalId)
            : null;
          const requester = approvalDeliveryRecipient(commandApproval?.request as ApprovalRequester | undefined);
          if (
            d.destination.commandApprovalId &&
            (!commandApproval ||
              !requester ||
              !samePerson(requester, d.destination.target) ||
              d.idempotencyKey !== approvalDeliveryKey(d.destination.commandApprovalId, commandApproval))
          )
            return undefined;
          let card: { text: string; blocks: Array<Record<string, unknown>> } | null = null;
          if (d.destination.deploymentAccess) card = deployAccessMessage(d.destination.deploymentAccess, d.text);
          if (commandApproval)
            card = approvalMessage([
              {
                ...commandApproval,
                reason: commandApproval.reason ?? "Approval required",
                ...(deps.webUiPublicUrl && commandApproval.sessionId
                  ? {
                      originUrl: `${trimTrailingSlashes(deps.webUiPublicUrl.trim())}/s/${encodeURIComponent(commandApproval.sessionId)}`,
                    }
                  : {}),
              },
            ]);
          let text = card?.text ?? toSlackMrkdwn(stripReactionDirectives(d.text));
          if (!text.trim() && !d.attachments?.length) return undefined;
          const channel = await openConversationFor(client, [d.destination.target]);
          const threadTs = d.destination.threadTs;
          const footer = deliveryFooter(d);
          if (!text.trim() && !footer.length && d.attachments?.length) text = "Files attached.";
          const blocks = card?.blocks ?? (footer.length ? blocksWithContext(text, footer) : undefined);
          let uploadError: unknown;
          let reused = false;
          if (text.trim() || blocks) {
            const posted = await postWithVerify(
              client,
              {
                ...slackReplyArgs(channel, text, threadTs, {
                  unfurlLinks: d.destination.unfurlLinks,
                  persona: d.destination.persona,
                }),
                ...(blocks ? { blocks } : {}),
              },
              d.idempotencyKey ?? d.id,
              recoveredRow(d) ? { verifyFirst: true, verifyOldest: String((d.createdAt! - 5_000) / 1000) } : undefined,
            );
            reused = Boolean(posted.reused);
          }
          if (d.attachments?.length && !reused) {
            try {
              await uploadAttachments(client, channel, threadTs, d.attachments, core);
            } catch (error) {
              throwIfRateLimited(error);
              uploadError = error;
              console.error(`[slack-plugin] principal delivery ${d.id} attachment upload failed:`, errMessage(error));
            }
          }
          if (uploadError) {
            await client.chat
              .postMessage(
                slackPersonaReplyArgs(channel, uploadFailureNote(uploadError), threadTs, {
                  persona: d.destination.persona,
                  webUiPublicUrl: deps.webUiPublicUrl,
                }),
              )
              .catch(swallowAs("slack: post principal upload-failure note", undefined));
          }
          return { recipientThreadRef: dmThreadRef(channel, threadTs) };
        } finally {
          slackApiMs = Math.round(performance.now() - tPost);
        }
      },
      ack: (body) => ackDelivery(d.id, mergeSlackApiMs(body, slackApiMs)),
      onError: logDeliveryError(d.id),
    });
  }

  return {
    deliver: (client, d) =>
      d.destination.type === "principal" ? deliverToPrincipal(client, d) : deliverToConversation(client, d),
  };
}
