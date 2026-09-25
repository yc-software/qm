import { deployAccessMessage } from "./deploy-access.ts";
import { approvalDeliveryKey, approvalDeliveryRecipient } from "../core/approval-store.ts";
import { samePerson } from "../directory/person.ts";
import { approvalMessage } from "./approval-cards.ts";
import { keychainApprovalMessage, keychainApprovalOrigin } from "./keychain-approvals.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { performance } from "node:perf_hooks";
import {
  botIdentityArgs,
  createDeliveryTracker,
  createThreadTracker,
  deliverWithRetry,
  dmThreadRef,
  openConversationFor,
  findPostedByKey,
  parseDeliveryTarget,
  postWithVerify,
  recoveryVerifyOldest,
  renderTaskList,
  slackReplyArgs,
  slackSectionBlocks,
  stripReactionDirectives,
  toSlackMrkdwn,
  uploadAttachments,
  uploadFailureNote,
  applyReactions,
} from "./lib.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { Delivery } from "../types.ts";
import type { TurnFlow } from "./turn-flow.ts";
import { cleanAgentReplyForSlack, stripSlackDirectives } from "./messaging.ts";
import { cronIdOf } from "../sessions/session-store.ts";
import { slackErrorCode } from "./payloads.ts";

const DELIVERY_CLAIM_MS = 15_000;
const SLOW_DRAIN_ALARM_MS = 120_000;
const PERMANENT_POST_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "account_inactive",
  "user_not_found",
  "cannot_reply_to_message",
  "message_not_found",
]);

const DELIVERY_CLAIM_MARGIN_MS = 2_000;

const RUN_RECOVERY_GRACE_MS = 15_000;

function mergeSlackApiMs(body: unknown, slackApiMs: number | undefined): unknown {
  if (slackApiMs === undefined) return body;
  if (body == null) return { slackApiMs };
  if (typeof body === "object") return { ...(body as object), slackApiMs };
  return body;
}

export function createDeliveryPoller(deps: {
  core: SlackCoreClient;
  webUiPublicUrl?: string;
  flow: TurnFlow;
  threads: ReturnType<typeof createThreadTracker>;
  clientForIdentity(identity: string): any;
  claimMs?: number;
  slowDrainMs?: number;
}): { pollDeliveries(client: any): Promise<boolean> } {
  const { core, flow, threads, clientForIdentity } = deps;
  const claimMs = deps.claimMs ?? DELIVERY_CLAIM_MS;
  const slowDrainMs = deps.slowDrainMs ?? SLOW_DRAIN_ALARM_MS;
  const claimMargin = Math.min(DELIVERY_CLAIM_MARGIN_MS, Math.floor(claimMs / 3));
  const recoveredRow = (d: Delivery): boolean => typeof d.createdAt === "number" && Date.now() - d.createdAt > claimMs;
  const { inFlightRuns } = flow;

  async function drainClaimed(
    types: string[],
    deliver: (d: Delivery) => Promise<void>,
    leaseLost?: () => boolean,
  ): Promise<number> {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    const expiresAt = new Map<string, number>();

    const claim = async (): Promise<{ rows: Delivery[]; complete: boolean }> => {
      const rows: Delivery[] = [];
      let complete = true;
      for (const t of types) {
        try {
          const claimed = await core.claimDeliveries(t, claimMs);
          const at = Date.now();
          for (const r of claimed) expiresAt.set(r.id, at + claimMs);
          rows.push(...claimed);
        } catch {
          complete = false;
        }
      }
      return { rows, complete };
    };
    const t0 = Date.now();
    const queue = (await claim()).rows;
    const seen = new Set(queue.map((d) => d.id));
    const absorb = (fresh: Delivery[]): void => {
      for (const f of fresh) {
        if (!seen.has(f.id)) {
          seen.add(f.id);
          queue.push(f);
        }
      }
    };

    const reclaimOwnership = async (id: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (leaseLost?.()) return false;
        if (attempt > 0) await sleep(Math.min(300, claimMargin));
        const { rows, complete } = await claim();
        absorb(rows);
        if (rows.some((f) => f.id === id)) return true;
        if (!complete) continue;
      }
      return false;
    };
    for (let i = 0; i < queue.length; i++) {
      if (leaseLost?.()) {
        console.error("[slack-plugin] delivery dispatch lease lost mid-drain — stopping; rows recover after claim TTL");
        return queue.length;
      }
      const d = queue[i]!;
      const exp = expiresAt.get(d.id) ?? 0;
      if (Date.now() >= exp - claimMargin) {
        const remaining = exp - Date.now();
        if (remaining > 0) await sleep(remaining);
        if (!(await reclaimOwnership(d.id))) {
          seen.delete(d.id);
          console.log(
            `[slack-plugin] delivery ${d.id} claim lost after ${Date.now() - t0}ms (another relay owns it, or it was acked) — skipping`,
          );
          continue;
        }
      }
      if (leaseLost?.()) {
        console.error("[slack-plugin] delivery dispatch lease lost mid-drain — stopping; rows recover after claim TTL");
        return queue.length;
      }
      await deliver(d);
    }
    return queue.length;
  }

  const ackDelivery = (id: string, body?: unknown): Promise<void> =>
    core.ackDelivery(id, body as { recipientThreadRef?: string; slackApiMs?: number } | undefined);

  function deliveryFooter(d: Delivery): Array<Record<string, unknown>> {
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

  const deliveryTracker = createDeliveryTracker();
  const undeliverableReported = new Set<string>();

  const logDeliveryError =
    (id: string) =>
    (stage: "post" | "ack", err: unknown, gaveUp: boolean): void => {
      const code = slackErrorCode(err);
      if (stage === "post" && gaveUp && code && PERMANENT_POST_ERRORS.has(code) && !undeliverableReported.has(id)) {
        if (undeliverableReported.size >= 5000) undeliverableReported.clear();
        undeliverableReported.add(id);
        void core
          .reportDeliveryUndeliverable?.(id, code)
          .catch(swallowAs("slack-plugin: undeliverable report", undefined));
      }
      console.error(
        `[slack-plugin] delivery ${id} ${stage} failed${gaveUp ? " (giving up)" : ""}:`,
        (err as Error).message,
      );
    };

  async function deliverToConversations(client: any, leaseLost?: () => boolean): Promise<number> {
    return drainClaimed(
      ["slack", "group"],
      async (d) => {
        const runId = d.idempotencyKey?.startsWith("run:") ? d.idempotencyKey.slice("run:".length) : undefined;
        if (runId && inFlightRuns.has(runId)) return;
        if (runId && typeof d.createdAt === "number" && Date.now() - d.createdAt < RUN_RECOVERY_GRACE_MS) return;
        let slackApiMs: number | undefined;
        await deliverWithRetry({
          tracker: deliveryTracker,
          id: d.id,
          post: async () => {
            const tPost = performance.now();
            try {
              const postClient = d.destination.identity ? clientForIdentity(d.destination.identity) : client;
              const { channel, threadTs } = parseDeliveryTarget(d.destination.target);
              if (d.destination.react) {
                const { failed } = await applyReactions(client, channel, d.destination.react.messageTs, [
                  d.destination.react.emoji,
                ]);
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
                  const code = (err as { data?: { error?: string } })?.data?.error;
                  if (code !== "already_pinned" && code !== "no_pin" && code !== "not_pinned")
                    console.error(
                      `[slack-plugin] delivery ${d.id} native ${remove ? "unpin" : "pin"} failed: ${code ?? (err as Error).message}`,
                    );
                }
                return undefined;
              }
              if (d.destination.delete) {
                try {
                  await client.chat.delete({ channel, ts: d.destination.delete.messageTs });
                } catch (err) {
                  console.error(
                    `[slack-plugin] delivery ${d.id} delete failed: ${slackErrorCode(err) ?? (err as Error).message} (own messages only)`,
                  );
                }
                return undefined;
              }
              let text = toSlackMrkdwn(runId ? cleanAgentReplyForSlack(d.text).text : stripSlackDirectives(d.text));
              const replayAttachments = async (root?: string): Promise<void> => {
                if (!d.attachments?.length) return;
                try {
                  await uploadAttachments(client, channel, root, d.attachments, core);
                } catch (err) {
                  console.error(
                    "%s",
                    `[slack-plugin] delivery ${d.id} attachment upload failed:`,
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
              const taskList = d.destination.taskList?.length ? renderTaskList(d.destination.taskList) : undefined;
              const footerBlocks =
                taskList || footer.length
                  ? [
                      ...(text.trim() ? slackSectionBlocks(text) : []),
                      ...(taskList ? [{ type: "section", text: { type: "mrkdwn", text: taskList } }] : []),
                      ...(footer.length ? [{ type: "context", elements: footer }] : []),
                    ]
                  : undefined;
              if (!text.trim() && !(messageFooter.length && d.attachments?.length)) {
                if (taskList) {
                  let preserved = false;
                  if (d.destination.editRef) {
                    try {
                      await client.chat.update({
                        channel,
                        ts: d.destination.editRef,
                        text: taskList,
                        blocks: [{ type: "section", text: { type: "mrkdwn", text: taskList } }],
                        ...botIdentityArgs(),
                      });
                      preserved = true;
                    } catch (error) {
                      swallow("slack: preserve recovered task list", error);
                    }
                  }
                  if (!preserved) {
                    await client.chat.postMessage({
                      ...slackReplyArgs(channel, taskList, threadTs, { threadOnly: Boolean(threadTs) }),
                      blocks: [{ type: "section", text: { type: "mrkdwn", text: taskList } }],
                    });
                  }
                } else if (d.destination.editRef) {
                  await client.chat
                    .delete({ channel, ts: d.destination.editRef })
                    .catch(swallowAs("slack: delete status placeholder", undefined));
                }
                await replayAttachments(threadTs);
                if (d.attachments?.length && threadTs) threads.mark(channel, threadTs, true);
                return undefined;
              }
              const verifyOldest = recoveryVerifyOldest(
                typeof d.createdAt === "number" ? d.createdAt : undefined,
                d.destination.editRef,
              );
              const deliveredMarker = (): Promise<{ ts: string; channel: string } | undefined> =>
                findPostedByKey(
                  postClient,
                  { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
                  d.idempotencyKey ?? d.id,
                  verifyOldest ?? String(Date.now() / 1000 - 60),
                ).catch(swallowAs("slack: delivered-marker probe", undefined));
              if (d.destination.editRef) {
                const unfurlLinks = runId ? false : d.destination.unfurlLinks;
                try {
                  const alreadyDelivered = d.attachments?.length ? await deliveredMarker() : undefined;
                  await client.chat.update({
                    channel,
                    ts: d.destination.editRef,
                    text,
                    ...(footerBlocks ? { blocks: footerBlocks } : {}),
                    ...botIdentityArgs(),
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
                d.idempotencyKey ?? d.id,
                runId || recoveredRow(d) ? { verifyFirst: true, ...(verifyOldest ? { verifyOldest } : {}) } : undefined,
              );
              const root = threadTs ?? (res?.ts ? String(res.ts) : undefined);
              if (root) threads.mark(channel, root, true);
              if (!res.reused) await replayAttachments(root);
              return undefined;
            } finally {
              slackApiMs = Math.round(performance.now() - tPost);
            }
          },
          ack: async (body) => {
            if (runId) await core.taskAcknowledgements?.finish(client, runId);
            return ackDelivery(d.id, mergeSlackApiMs(body, slackApiMs));
          },
          onError: logDeliveryError(d.id),
        });
      },
      leaseLost,
    );
  }

  async function deliverToPrincipals(client: any, leaseLost?: () => boolean): Promise<number> {
    return drainClaimed(
      ["principal"],
      async (d) => {
        let slackApiMs: number | undefined;
        await deliverWithRetry({
          tracker: deliveryTracker,
          id: d.id,
          post: async () => {
            const tPost = performance.now();
            try {
              const approval =
                d.destination.keychainAskId && core.keychainApprovals
                  ? await core.keychainApprovals.get(d.destination.keychainAskId, d.destination.target)
                  : null;
              const commandApproval = d.destination.commandApprovalId
                ? await core.getApproval(d.destination.commandApprovalId)
                : null;
              const requester = approvalDeliveryRecipient(
                commandApproval?.request?.actor as { externalId?: string } | undefined,
              );
              if (
                d.destination.commandApprovalId &&
                (!commandApproval ||
                  !requester ||
                  !samePerson(requester, d.destination.target) ||
                  d.idempotencyKey !== approvalDeliveryKey(d.destination.commandApprovalId, commandApproval))
              )
                return undefined;
              let card: { text: string; blocks: Array<Record<string, unknown>> } | null = null;
              if (approval)
                card = keychainApprovalMessage(
                  approval,
                  await keychainApprovalOrigin(approval, client, deps.webUiPublicUrl),
                );
              else if (d.destination.deploymentAccess)
                card = deployAccessMessage(d.destination.deploymentAccess, d.text);
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
                  d.idempotencyKey ?? d.id,
                  recoveredRow(d)
                    ? { verifyFirst: true, verifyOldest: String((d.createdAt! - 5_000) / 1000) }
                    : undefined,
                );
                reused = Boolean(posted.reused);
              }
              if (d.attachments?.length && !reused) {
                try {
                  await uploadAttachments(client, channel, threadTs, d.attachments, core);
                } catch (error) {
                  uploadError = error;
                  console.error(
                    `[slack-plugin] principal delivery ${d.id} attachment upload failed:`,
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
            } finally {
              slackApiMs = Math.round(performance.now() - tPost);
            }
          },
          ack: (body) => ackDelivery(d.id, mergeSlackApiMs(body, slackApiMs)),
          onError: logDeliveryError(d.id),
        });
      },
      leaseLost,
    );
  }

  async function pollDeliveries(client: any): Promise<boolean> {
    const ran = await core.holdDeliveryDispatch(async (lost) => {
      let lostFlag = false;
      void lost.then(() => {
        lostFlag = true;
      });
      const leaseLost = (): boolean => lostFlag;
      const cycleStart = Date.now();
      const rowCounts = await Promise.all([
        deliverToConversations(client, leaseLost),
        deliverToPrincipals(client, leaseLost),
      ]);
      if (!lostFlag)
        await core.taskAcknowledgements
          ?.reconcile(client)
          .catch(swallowAs("slack: task ack reconciliation", undefined));
      const cycleMs = Date.now() - cycleStart;
      if (cycleMs >= slowDrainMs) {
        void core
          .reportSlowDeliveryDrain?.({ durationMs: cycleMs, rows: rowCounts.reduce((a, b) => a + b, 0) })
          .catch(swallowAs("slack-plugin: slow-drain report", undefined));
      }

      return !lostFlag;
    });
    return ran === true;
  }

  return { pollDeliveries };
}
