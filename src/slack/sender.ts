import { extractPrivateContinuation } from "./external-access.ts";
import { deployAccessMessage } from "./deploy-access.ts";
import { approvalDeliveryKey, approvalDeliveryRecipient } from "../core/approval-store.ts";
import { samePerson } from "../directory/person.ts";
import { approvalMessage } from "./approval-cards.ts";
import { deliverKeychainCard } from "./keychain-approvals.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import {
  botIdentityArgs,
  createThreadTracker,
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
  stripReactionDirectives,
  toSlackMrkdwn,
  uploadAttachments,
  uploadFailureNote,
  applyReactions,
} from "./lib.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { OutboundPost, PostReceipt } from "../surfaces/outbound.ts";
import type { TurnFlow } from "./turn-flow.ts";
import { cleanAgentReplyForSlack, stripSlackDirectives } from "./messaging.ts";
import { cronIdOf } from "../sessions/session-store.ts";
import { slackErrorCode } from "./payloads.ts";

const PERMANENT_POST_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "account_inactive",
  "user_not_found",
  "cannot_reply_to_message",
  "message_not_found",
]);

const SETTLED_PIN_ERRORS = new Set(["already_pinned", "no_pin", "not_pinned"]);

const STATUS_PLACEHOLDER_LOOKBACK_MS = 6 * 3_600_000;

type Post = OutboundPost;

export function createSlackSender(deps: {
  clientForAccount?: (accountId: string, teamId?: string) => any;
  externalNamespace?: (accountId: string) => string | undefined;
  continuePrivate?: (runId: string, task: string) => Promise<void>;
  core: SlackCoreClient;
  webUiPublicUrl?: string;
  flow: TurnFlow;
  runInFlight?: (runId: string) => boolean;
  threads: ReturnType<typeof createThreadTracker>;
  clientForIdentity(identity: string): any;
  defaultClient?: any;
}): (post: Post) => Promise<PostReceipt | void> {
  const { core, flow, threads, clientForIdentity } = deps;
  const runInFlight = deps.runInFlight ?? ((runId: string) => flow.inFlightRuns.has(runId));

  function deliveryFooter(d: Post): Array<Record<string, unknown>> {
    const base = deps.webUiPublicUrl?.trim().replace(/\/+$/, "");
    const id = d.provenance?.trigger === "cron" ? cronIdOf(d.provenance.sourceThreadRef) : null;
    const sender = d.destination.relaySender?.trim().replace(/^@+/, "");
    const attribution = sender ? [{ type: "plain_text", text: `Sent for @${sender}`, emoji: false }] : [];
    if (!base || !id) return attribution;
    const title = (d.provenance?.sourceTitle?.trim() || "Cron")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    return [
      ...attribution,
      { type: "mrkdwn", text: `${title} · <${base}/crons/${encodeURIComponent(id)}|Settings>`, verbatim: true },
    ];
  }

  const postError = (err: unknown): Error => {
    const error = err instanceof Error ? err : new Error(errMessage(err));
    const code = slackErrorCode(err);
    return code && PERMANENT_POST_ERRORS.has(code) ? Object.assign(error, { permanent: true }) : error;
  };

  function deliveryClient(destination: Post["destination"]): any {
    let client = destination.slackAccountId ? undefined : deps.defaultClient;
    if (deps.clientForAccount)
      client = deps.clientForAccount(destination.slackAccountId ?? "default", destination.slackTeamId);
    if (!client) throw new Error(`Slack account ${destination.slackAccountId ?? "default"} is not connected`);
    return client;
  }

  async function postToConversation(d: Post): Promise<PostReceipt | void> {
    const client = deliveryClient(d.destination);
    const runId = d.idempotencyKey.startsWith("run:") ? d.idempotencyKey.slice("run:".length) : undefined;
    const namespace = deps.externalNamespace?.(d.destination.slackAccountId ?? "default");
    if (
      namespace &&
      (parseDeliveryTarget(d.destination.target).channel.startsWith("D")
        ? runId && d.destination.slackPolicyNamespace !== namespace
        : !d.provenance?.sourceThreadRef.startsWith(`${namespace}:`))
    ) {
      console.error(
        `[slack-plugin] post ${d.idempotencyKey} is outside external account ${namespace}'s policy — dropped`,
      );
      return;
    }
    if (runId && runInFlight(runId)) return { deferred: true };
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
          `[slack-plugin] delivery ${d.idempotencyKey} reaction(s) failed: ${failed.join(", ")} (check reactions:write / message ts)`,
        );
      return undefined;
    }
    if (d.destination.pin) {
      const { messageTs, remove } = d.destination.pin;
      try {
        if (remove) await client.pins.remove({ channel, timestamp: messageTs });
        else await client.pins.add({ channel, timestamp: messageTs });
      } catch (err) {
        const code = slackErrorCode(err);
        if (!code || !SETTLED_PIN_ERRORS.has(code))
          console.error(
            `[slack-plugin] delivery ${d.idempotencyKey} native ${remove ? "unpin" : "pin"} failed: ${code ?? (err as Error).message}`,
          );
      }
      return undefined;
    }
    if (d.destination.delete) {
      const { messageTs } = d.destination.delete;
      try {
        await client.chat.delete({ channel, ts: messageTs });
      } catch (err) {
        const code = slackErrorCode(err);
        if (code !== "message_not_found")
          console.error(
            `[slack-plugin] delivery ${d.idempotencyKey} delete failed: ${code ?? (err as Error).message} (own messages only)`,
          );
      }
      return undefined;
    }
    let editRef = d.destination.editRef;
    if (!editRef && runId) {
      const placeholder = await findPostedByKey(
        client,
        { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
        statusPlaceholderKey(runId),
        String(((d.createdAt ?? Date.now()) - STATUS_PLACEHOLDER_LOOKBACK_MS) / 1000),
      ).catch(swallowAs("slack: status-placeholder probe", undefined));
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
        console.error(
          "%s",
          `[slack-plugin] delivery ${d.idempotencyKey} attachment upload failed:`,
          (err as Error).message,
        );
        await client.chat
          .postMessage(slackReplyArgs(channel, uploadFailureNote(err), root))
          .catch(swallowAs("slack: post upload-failure note", undefined));
      }
    };
    const messageFooter = deliveryFooter(d);
    if (!text.trim() && !messageFooter.length && d.attachments?.length) text = "Files attached.";
    const footer = [
      ...messageFooter,
      ...(d.destination.debugFooter ? [{ type: "mrkdwn", text: d.destination.debugFooter }] : []),
    ];
    const footerBlocks = footer.length
      ? [...(text.trim() ? slackSectionBlocks(text) : []), { type: "context", elements: footer }]
      : undefined;
    if (!text.trim() && !(messageFooter.length && d.attachments?.length)) {
      if (editRef) {
        await client.chat
          .delete({ channel, ts: editRef })
          .catch(swallowAs("slack: delete status placeholder", undefined));
      }
      await replayAttachments(threadTs);
      if (d.attachments?.length && threadTs) threads.mark(channel, threadTs, true);
      return undefined;
    }
    const verifyOldest = recoveryVerifyOldest(d.createdAt, editRef);
    const deliveredMarker = (): Promise<{ ts: string; channel: string } | undefined> =>
      findPostedByKey(
        postClient,
        { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
        d.idempotencyKey,
        verifyOldest ?? String(Date.now() / 1000 - 60),
      ).catch(swallowAs("slack: delivered-marker probe", undefined));
    if (editRef) {
      const unfurlLinks = runId ? false : d.destination.unfurlLinks;
      try {
        const alreadyDelivered = d.attachments?.length ? await deliveredMarker() : undefined;
        await client.chat.update({
          channel,
          ts: editRef,
          text,
          ...(footerBlocks ? { blocks: footerBlocks } : {}),
          ...botIdentityArgs(),
          metadata: deliveryMetadata(d.idempotencyKey),
          ...(unfurlLinks !== undefined ? { unfurl_links: unfurlLinks, unfurl_media: unfurlLinks } : {}),
        });
        if (threadTs) threads.mark(channel, threadTs, true);
        if (!alreadyDelivered) await replayAttachments(threadTs);
        return undefined;
      } catch (e) {
        swallow("slack: finalize recovered reply in place", e);
      }
    }
    const res = await postWithVerify(
      postClient,
      {
        ...slackReplyArgs(channel, text, threadTs, {
          unfurlLinks: runId ? false : d.destination.unfurlLinks,
        }),
        ...(footerBlocks ? { blocks: footerBlocks } : {}),
      },
      d.idempotencyKey,
      runId || d.retry ? { verifyFirst: true, ...(verifyOldest ? { verifyOldest } : {}) } : undefined,
    );
    const root = threadTs ?? (res?.ts ? String(res.ts) : undefined);
    if (root) threads.mark(channel, root, true);
    if (!res.reused) await replayAttachments(root);
    return undefined;
  }

  async function postToPrincipal(d: Post): Promise<PostReceipt | void> {
    const client = deliveryClient(d.destination);
    if (d.destination.keychainAskId) {
      const dm = await openConversationFor(client, [d.destination.target]);
      await deliverKeychainCard(core, client, d, dm, d.destination.threadTs, deps.webUiPublicUrl);
      return undefined;
    }
    const commandApproval = d.destination.commandApprovalId
      ? await core.getApproval(d.destination.commandApprovalId)
      : null;
    const requester = approvalDeliveryRecipient(commandApproval?.request?.actor as { externalId?: string } | undefined);
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
      card = approvalMessage([{ ...commandApproval, reason: commandApproval.reason ?? "Approval required" }]);
    let text = card?.text ?? toSlackMrkdwn(stripReactionDirectives(d.text));
    if (!text.trim() && !d.attachments?.length) return undefined;
    const channel = await openConversationFor(client, [d.destination.target]);
    const threadTs = d.destination.threadTs;
    const footer = deliveryFooter(d);
    if (!text.trim() && !footer.length && d.attachments?.length) text = "Files attached.";
    const blocks =
      card?.blocks ??
      (footer.length
        ? [...(text.trim() ? slackSectionBlocks(text) : []), { type: "context", elements: footer }]
        : undefined);
    let uploadError: unknown;
    let reused = false;
    if (text.trim() || blocks) {
      const posted = await postWithVerify(
        client,
        {
          ...slackReplyArgs(channel, text, threadTs, { unfurlLinks: d.destination.unfurlLinks }),
          ...(blocks ? { blocks } : {}),
        },
        d.idempotencyKey,
        d.retry ? { verifyFirst: true, verifyOldest: recoveryVerifyOldest(d.createdAt, undefined) } : undefined,
      );
      reused = Boolean(posted.reused);
    }
    if (d.attachments?.length && !reused) {
      try {
        await uploadAttachments(client, channel, threadTs, d.attachments, core);
      } catch (error) {
        uploadError = error;
        console.error(
          `[slack-plugin] principal delivery ${d.idempotencyKey} attachment upload failed:`,
          errMessage(error),
        );
      }
    }
    if (uploadError) {
      await client.chat
        .postMessage(slackReplyArgs(channel, uploadFailureNote(uploadError), threadTs))
        .catch(swallowAs("slack: post principal upload-failure note", undefined));
    }
    return { recipientThreadRef: dmThreadRef(channel, threadTs) };
  }

  return async (post) => {
    try {
      const receipt =
        post.destination.type === "principal" ? await postToPrincipal(post) : await postToConversation(post);
      const runId = post.idempotencyKey.startsWith("run:") ? post.idempotencyKey.slice("run:".length) : undefined;
      if (runId && !receipt?.deferred)
        await core.taskAcknowledgements
          ?.finish(deliveryClient(post.destination), runId)
          .catch(swallowAs("slack: finish task acknowledgement", undefined));
      return receipt;
    } catch (err) {
      throw postError(err);
    }
  };
}
