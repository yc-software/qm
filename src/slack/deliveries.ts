import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { performance } from "node:perf_hooks";
import {
  botIdentityArgs,
  createDeliveryTracker,
  createThreadTracker,
  deliverWithRetry,
  dmThreadRef,
  openConversationFor,
  parseDeliveryTarget,
  postWithVerify,
  renderTaskList,
  slackReplyArgs,
  slackSectionBlocks,
  stripReactionDirectives,
  toSlackMrkdwn,
  uploadAttachments,
  uploadFailureNote,
  applyReactions,
  approvalMessage,
  messageApprovalMessage,
} from "./lib.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { MessageApprovalService } from "../core/message-approval.ts";
import type { Delivery } from "../types.ts";
import type { CoreBridge } from "./core-bridge.ts";
import type { Mirror } from "./mirror.ts";
import { cleanAgentReplyForSlack, stripSlackDirectives } from "./messaging.ts";

const DELIVERY_CLAIM_MS = 15_000;

const RUN_RECOVERY_GRACE_MS = 15_000;

function mergeSlackApiMs(body: unknown, slackApiMs: number | undefined): unknown {
  if (slackApiMs === undefined) return body;
  if (body == null) return { slackApiMs };
  if (typeof body === "object") return { ...(body as object), slackApiMs };
  return body;
}

function slackMessageMissing(error: unknown): boolean {
  const value = error as { data?: { error?: unknown }; message?: unknown };
  return value?.data?.error === "message_not_found" || value?.message === "message_not_found";
}

export function createDeliveryPoller(deps: {
  core: SlackCoreClient;
  messageApprovals: MessageApprovalService;
  bridge: CoreBridge;
  mirror: Mirror;
  threads: ReturnType<typeof createThreadTracker>;
  clientForIdentity(identity: string): any;
}): { pollDeliveries(client: any): Promise<void> } {
  const { core, messageApprovals, bridge, mirror, threads, clientForIdentity } = deps;
  const { inFlightRuns, fetchBlobFromCore, fetchFileArtifactFromCore } = bridge;
  const { mirrorSelfPost } = mirror;

  async function fetchDeliveries(type: string): Promise<Delivery[]> {
    try {
      return await core.claimDeliveries(type, DELIVERY_CLAIM_MS);
    } catch {
      return [];
    }
  }

  const ackDelivery = (id: string, body?: unknown): Promise<void> =>
    core.ackDelivery(id, body as { recipientThreadRef?: string; slackApiMs?: number } | undefined);

  const neutralizeApprovalPost = async (postClient: any, message: { channel: string; ts: string }): Promise<void> => {
    try {
      await postClient.chat.delete({ channel: message.channel, ts: message.ts, ...botIdentityArgs() });
    } catch {
      await postClient.chat
        .update({
          channel: message.channel,
          ts: message.ts,
          text: "This draft approval card was superseded.",
          blocks: [],
          mrkdwn: false,
          ...botIdentityArgs(),
        })
        .catch(() => undefined);
    }
  };

  const acknowledge = async (delivery: Delivery, body: unknown, client: any, slackApiMs?: number): Promise<void> => {
    const approval = (
      body as { messageApproval?: { id?: string; version?: number; channel?: string; ts?: string } } | undefined
    )?.messageApproval;
    const recipientThreadRef = (body as { recipientThreadRef?: string } | undefined)?.recipientThreadRef;
    if (approval?.id && approval.version && approval.channel && approval.ts) {
      const result = await messageApprovals.acknowledgeSlackMessage(
        approval.id,
        approval.version,
        approval.channel,
        approval.ts,
      );
      const postClient = delivery.destination.identity ? clientForIdentity(delivery.destination.identity) : client;
      const losing = [
        ...(!result.winner ? [{ channel: approval.channel, ts: approval.ts }] : []),
        ...(result.displaced ? [result.displaced] : []),
      ].filter(
        (message, index, all) =>
          !(result.current && result.current.channel === message.channel && result.current.ts === message.ts) &&
          all.findIndex((candidate) => candidate.channel === message.channel && candidate.ts === message.ts) === index,
      );
      await Promise.all(losing.map((message) => neutralizeApprovalPost(postClient, message)));
      await core.ackDelivery(delivery.id, {
        ...(recipientThreadRef ? { recipientThreadRef } : {}),
        ...(slackApiMs === undefined ? {} : { slackApiMs }),
      });
      return;
    }
    await ackDelivery(delivery.id, mergeSlackApiMs(body, slackApiMs));
  };

  const deliveryTracker = createDeliveryTracker();

  const logDeliveryError =
    (id: string) =>
    (stage: "post" | "ack", err: unknown, gaveUp: boolean): void => {
      console.error(
        `[slack-plugin] delivery ${id} ${stage} failed${gaveUp ? " (giving up)" : ""}:`,
        (err as Error).message,
      );
    };

  async function postMessageApproval(
    delivery: Delivery,
    postClient: any,
    channel: string,
    threadTs?: string,
  ): Promise<unknown> {
    const approvalRef = delivery.destination.messageApproval;
    if (!approvalRef) return undefined;
    let record = await messageApprovals.get(approvalRef.id);
    if (!record) return undefined;
    let slackMessage = record.slackMessage;
    for (let renderAttempt = 0; renderAttempt < 8; renderAttempt++) {
      const renderedVersion = record.version;
      const rendered = messageApprovalMessage(record);
      if (slackMessage) {
        try {
          await postClient.chat.update({
            channel: slackMessage.channel,
            ts: slackMessage.ts,
            text: rendered.text,
            blocks: rendered.blocks,
            mrkdwn: false,
            ...botIdentityArgs(),
          });
        } catch (error) {
          if (!slackMessageMissing(error)) throw error;
          const invalidated = await messageApprovals.invalidateSlackMessage(
            record.id,
            slackMessage.channel,
            slackMessage.ts,
          );
          const current = await messageApprovals.get(record.id);
          if (!current) return undefined;
          record = current;
          slackMessage = invalidated ? undefined : current.slackMessage;
          if (!invalidated && slackMessage) continue;
        }
      }
      if (!slackMessage) {
        slackMessage = await postWithVerify(
          postClient,
          {
            ...slackReplyArgs(channel, rendered.text, threadTs, { threadOnly: Boolean(threadTs) }),
            blocks: rendered.blocks,
            mrkdwn: false,
          },
          `message-approval:${record.id}:card:${renderedVersion}`,
          {
            verifyFirst: true,
            verifyOldest: String((record.createdAt - 5_000) / 1000),
          },
        );
      }
      const current = await messageApprovals.get(record.id);
      if (!current || current.version === renderedVersion) {
        return current && slackMessage
          ? {
              messageApproval: {
                id: current.id,
                version: renderedVersion,
                channel: slackMessage.channel,
                ts: slackMessage.ts,
              },
            }
          : undefined;
      }
      record = current;
    }
    throw new Error("message approval changed repeatedly while its Slack card was rendering");
  }

  async function deliverToConversations(client: any): Promise<void> {
    for (const d of [...(await fetchDeliveries("slack")), ...(await fetchDeliveries("group"))]) {
      const runId = d.idempotencyKey?.startsWith("run:") ? d.idempotencyKey.slice("run:".length) : undefined;
      if (runId && inFlightRuns.has(runId)) continue;
      if (runId && typeof d.createdAt === "number" && Date.now() - d.createdAt < RUN_RECOVERY_GRACE_MS) continue;
      let slackApiMs: number | undefined;
      await deliverWithRetry({
        tracker: deliveryTracker,
        id: d.id,
        post: async () => {
          const tPost = performance.now();
          try {
            const postClient = d.destination.identity ? clientForIdentity(d.destination.identity) : client;
            const commandApproval = d.destination.commandApproval;
            if (commandApproval) {
              const stored = await Promise.all(
                commandApproval.requestIds.map((requestId) => core.getApproval(requestId)),
              );
              const approvals = stored.flatMap((approval, index) =>
                approval
                  ? [
                      {
                        requestId: commandApproval.requestIds[index]!,
                        command: approval.command,
                        reason: approval.reason ?? "requires approval",
                        ...(approval.matched ? { matched: approval.matched } : {}),
                        ...(approval.purpose ? { purpose: approval.purpose } : {}),
                        ...(approval.summary ? { summary: approval.summary } : {}),
                        ...(approval.summaryDetail ? { summaryDetail: approval.summaryDetail } : {}),
                        ...(approval.approvalKey ? { approvalKey: approval.approvalKey } : {}),
                        ...(approval.grantModes ? { grantModes: approval.grantModes } : {}),
                        ...(approval.blocksInput === undefined ? {} : { blocksInput: approval.blocksInput }),
                        ...(approval.kind ? { kind: approval.kind } : {}),
                      },
                    ]
                  : [],
              );
              if (!approvals.length) return undefined;
              const rendered = approvalMessage(approvals);
              const origin = parseDeliveryTarget(d.destination.target);
              await postWithVerify(
                postClient,
                {
                  ...slackReplyArgs(origin.channel, rendered.text, origin.threadTs, {
                    threadOnly: Boolean(origin.threadTs),
                  }),
                  blocks: rendered.blocks,
                },
                d.idempotencyKey ?? d.id,
                {
                  verifyFirst: true,
                  ...(typeof d.createdAt === "number" ? { verifyOldest: String((d.createdAt - 5_000) / 1000) } : {}),
                },
              );
              return undefined;
            }
            const approvalRef = d.destination.messageApproval;
            if (approvalRef) {
              const origin = parseDeliveryTarget(d.destination.target);
              return postMessageApproval(d, postClient, origin.channel, origin.threadTs);
            }
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
            if (d.destination.delete) {
              try {
                await client.chat.delete({ channel, ts: d.destination.delete.messageTs });
              } catch (err) {
                console.error(
                  `[slack-plugin] delivery ${d.id} delete failed: ${(err as { data?: { error?: string } })?.data?.error ?? (err as Error).message} (own messages only)`,
                );
              }
              return undefined;
            }
            const text = toSlackMrkdwn(runId ? cleanAgentReplyForSlack(d.text).text : stripSlackDirectives(d.text));
            const replayAttachments = async (root?: string): Promise<void> => {
              if (!d.attachments?.length) return;
              try {
                await uploadAttachments(
                  client,
                  channel,
                  root,
                  d.attachments,
                  fetchBlobFromCore,
                  fetchFileArtifactFromCore,
                );
              } catch (err) {
                console.error(`[slack-plugin] delivery ${d.id} attachment upload failed:`, (err as Error).message);
                await client.chat
                  .postMessage(slackReplyArgs(channel, uploadFailureNote(err), root))
                  .catch(swallowAs("slack: post upload-failure note", undefined));
              }
            };
            const taskList = d.destination.taskList?.length ? renderTaskList(d.destination.taskList) : undefined;
            const taskListBlocks = taskList
              ? [
                  ...slackSectionBlocks(text),
                  { type: "section", text: { type: "mrkdwn", text: taskList } },
                  ...(d.destination.debugFooter
                    ? [{ type: "context", elements: [{ type: "mrkdwn", text: d.destination.debugFooter }] }]
                    : []),
                ]
              : undefined;
            if (!text.trim()) {
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
                    mirrorSelfPost(channel, d.destination.editRef, taskList, { sub: threadTs, editedAt: Date.now() });
                  } catch (error) {
                    swallow("slack: preserve recovered task list", error);
                  }
                }
                if (!preserved) {
                  const posted = await client.chat.postMessage({
                    ...slackReplyArgs(channel, taskList, threadTs, { threadOnly: Boolean(threadTs) }),
                    blocks: [{ type: "section", text: { type: "mrkdwn", text: taskList } }],
                  });
                  mirrorSelfPost(channel, posted?.ts, taskList, { sub: threadTs });
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
            if (d.destination.editRef) {
              const unfurlLinks = runId ? false : d.destination.unfurlLinks;
              try {
                await client.chat.update({
                  channel,
                  ts: d.destination.editRef,
                  text,
                  ...(taskListBlocks ? { blocks: taskListBlocks } : {}),
                  ...botIdentityArgs(),
                  ...(unfurlLinks !== undefined ? { unfurl_links: unfurlLinks, unfurl_media: unfurlLinks } : {}),
                });
                if (threadTs) threads.mark(channel, threadTs, true);
                mirrorSelfPost(channel, d.destination.editRef, text, { sub: threadTs, editedAt: Date.now() });
                await replayAttachments(threadTs);
                return undefined;
              } catch (e) {
                swallow("slack: finalize recovered reply in place", e);
              }
            }
            const footerBlocks =
              taskListBlocks ??
              (d.destination.debugFooter && text.length <= 2900
                ? [
                    { type: "section", text: { type: "mrkdwn", text } },
                    { type: "context", elements: [{ type: "mrkdwn", text: d.destination.debugFooter }] },
                  ]
                : undefined);
            let composedUploadError: unknown;
            const canComposeUpload =
              d.attachments?.length &&
              !d.destination.identity &&
              !footerBlocks &&
              !runId &&
              d.destination.unfurlLinks === undefined;
            if (canComposeUpload) {
              try {
                const uploaded = await uploadAttachments(
                  client,
                  channel,
                  threadTs,
                  d.attachments!,
                  fetchBlobFromCore,
                  fetchFileArtifactFromCore,
                  { initialComment: text },
                );
                if (uploaded.uploaded) {
                  const root = threadTs ?? uploaded.messageTs;
                  if (root) threads.mark(channel, root, true);
                  mirrorSelfPost(channel, uploaded.messageTs, text, { sub: threadTs });
                  return undefined;
                }
              } catch (error) {
                composedUploadError = error;
                console.error(`[slack-plugin] delivery ${d.id} attachment upload failed:`, (error as Error).message);
              }
            }
            const res = await postWithVerify(
              postClient,
              {
                ...slackReplyArgs(channel, text, threadTs, { unfurlLinks: runId ? false : d.destination.unfurlLinks }),
                ...(footerBlocks ? { blocks: footerBlocks } : {}),
              },
              d.idempotencyKey ?? d.id,
              runId
                ? {
                    verifyFirst: true,
                    ...(typeof d.createdAt === "number" ? { verifyOldest: String((d.createdAt - 5_000) / 1000) } : {}),
                  }
                : undefined,
            );
            const root = threadTs ?? (res?.ts ? String(res.ts) : undefined);
            if (root) threads.mark(channel, root, true);
            if (!d.destination.identity) mirrorSelfPost(channel, res?.ts, text, { sub: threadTs });
            if (composedUploadError) {
              await client.chat
                .postMessage(slackReplyArgs(channel, uploadFailureNote(composedUploadError), root))
                .catch(swallowAs("slack: post upload-failure note", undefined));
            } else {
              await replayAttachments(root);
            }
            return undefined;
          } finally {
            slackApiMs = Math.round(performance.now() - tPost);
          }
        },
        ack: (body) => acknowledge(d, body, client, slackApiMs),
        onError: logDeliveryError(d.id),
      });
    }
  }

  async function deliverToPrincipals(client: any): Promise<void> {
    for (const d of await fetchDeliveries("principal")) {
      let slackApiMs: number | undefined;
      await deliverWithRetry({
        tracker: deliveryTracker,
        id: d.id,
        post: async () => {
          const tPost = performance.now();
          try {
            if (d.destination.messageApproval) {
              const channel = await openConversationFor(client, [d.destination.target]);
              const body = await postMessageApproval(d, client, channel);
              return { ...(body as object), recipientThreadRef: dmThreadRef(channel) };
            }
            const text = toSlackMrkdwn(stripReactionDirectives(d.text));
            if (!text.trim() && !d.attachments?.length) return undefined;
            const channel = await openConversationFor(client, [d.destination.target]);
            const threadTs = d.destination.threadTs;
            let composedUpload = false;
            let uploadError: unknown;
            if (text.trim() && d.attachments?.length && d.destination.unfurlLinks === undefined) {
              try {
                const uploaded = await uploadAttachments(
                  client,
                  channel,
                  threadTs,
                  d.attachments,
                  fetchBlobFromCore,
                  fetchFileArtifactFromCore,
                  { initialComment: text },
                );
                if (uploaded.uploaded) {
                  composedUpload = true;
                  mirrorSelfPost(channel, uploaded.messageTs, text, { kind: "dm", sub: threadTs });
                }
              } catch (error) {
                uploadError = error;
                console.error(`[slack-plugin] principal delivery ${d.id} attachment upload failed:`, errMessage(error));
              }
            }
            if (!composedUpload) {
              if (text.trim()) {
                const posted = await client.chat.postMessage(
                  slackReplyArgs(channel, text, threadTs, { unfurlLinks: d.destination.unfurlLinks }),
                );
                mirrorSelfPost(channel, posted?.ts, text, { kind: "dm", sub: threadTs });
              }
              if (d.attachments?.length && !uploadError) {
                try {
                  await uploadAttachments(
                    client,
                    channel,
                    threadTs,
                    d.attachments,
                    fetchBlobFromCore,
                    fetchFileArtifactFromCore,
                  );
                } catch (error) {
                  uploadError = error;
                  console.error(
                    `[slack-plugin] principal delivery ${d.id} attachment upload failed:`,
                    errMessage(error),
                  );
                }
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
    }
  }

  async function pollDeliveries(client: any): Promise<void> {
    await Promise.all([deliverToConversations(client), deliverToPrincipals(client)]);
  }

  return { pollDeliveries };
}
