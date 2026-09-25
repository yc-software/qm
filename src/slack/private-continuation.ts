import { uploadAttachments } from "./attachments.ts";
import { cleanAgentReplyForSlack } from "./messaging.ts";
import { toSlackMrkdwn } from "./mrkdwn.ts";
import { userFacingFailureClause } from "../core/failure-copy.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { ExternalSlackAccess } from "./external-access.ts";
import { companySlackActor } from "./external-access.ts";
import { dmThreadRef } from "./message-gating.ts";
import { encodeDeliveryTarget, parseDeliveryTarget, postWithVerify, slackReplyArgs } from "./delivery.ts";

export const PRIVATE_CONTINUATION_ACK = "I'll continue this in your DM, where I can use your private context.";

export async function continueInPrivate(
  core: SlackCoreClient,
  runId: string,
  task: string,
  account: (accountId: string) =>
    | {
        client: any;
        teamId: string;
        policy?: ExternalSlackAccess;
        inFlightRuns?: { add(id: string): void; delete(id: string): void };
      }
    | undefined,
): Promise<void> {
  const source = await core.privateContinuationSource?.(runId);
  const origin = source?.externalSlack;
  if (!source || !origin || !source.deliveryTarget)
    throw new Error("Private continuation requires a verified employee request");
  const current = account(origin.accountId);
  if (!current?.policy || current.teamId !== origin.teamId) throw new Error("Source Slack workspace is unavailable");
  const { client, policy } = current;
  const user = (await client.users.info({ user: origin.userId })).user;
  if (user?.id !== origin.userId) throw new Error("Slack requester identity could not be verified");
  const actor = companySlackActor(user, policy);
  if (actor.isExternalGuest || actor.externalId !== source.actor.externalId)
    throw new Error("Private continuation requester is no longer a verified employee");
  const opened = await client.conversations.open({ users: origin.userId });
  const dm = opened.channel?.id;
  if (typeof dm !== "string" || !dm.startsWith("D")) throw new Error("Could not open the requester's private DM");
  const { channel, threadTs } = parseDeliveryTarget(source.deliveryTarget);
  const key = `private-continuation:${runId}`;
  await postWithVerify(
    client,
    { ...slackReplyArgs(channel, PRIVATE_CONTINUATION_ACK, threadTs, { threadOnly: true }) },
    `${key}:ack`,
    { verifyFirst: true, verifyOldest: source.triggerTs ?? "0" },
  );
  const result = await core.submitTurn({
    actor,
    slackSource: { accountId: origin.accountId, teamId: origin.teamId, userId: origin.userId },
    conversation: {
      kind: "dm",
      threadRef: `slack-account:${origin.teamId}:${dmThreadRef(dm)}`,
      audience: [actor],
    },
    deliveryTarget: encodeDeliveryTarget(dm),
    text: `${source.text}\n\nContinue the remaining work: ${task}`,
    ...(source.priorTurns?.length ? { priorTurns: source.priorTurns } : {}),
    ...(source.overheard?.length ? { overheard: source.overheard } : {}),
    ...(source.attachments?.length ? { attachments: source.attachments } : {}),
    ...(source.conversationHeader
      ? { conversationHeader: `Source conversation context (not the current location):\n${source.conversationHeader}` }
      : {}),
    ...(source.timezone ? { timezone: source.timezone } : {}),
    gatewayContext: {
      location: "a private DM with the requesting employee",
      details: { channel: dm },
      instructions:
        "Continue the employee's request from the external Slack conversation. The request and relevant channel context are already included; do not ask them to repeat it. Use the normal personal-context authorization checks. Keep all private results and approvals in this DM. There is no automatic return to the source channel.",
    },
    liveActor: true,
    origin: { kind: "human" },
    idempotencyKey: key,
    async: true,
  });
  if (result.status !== "queued" && result.status !== "silent" && result.status !== "ok")
    throw new Error("Private continuation could not be queued");
  await core.ackRunDelivery(runId);
  if (result.status !== "queued" || !result.runId) return;
  const dmRunId = result.runId;
  current.inFlightRuns?.add(dmRunId);
  try {
    const outcome = await core.waitRun(dmRunId);
    if (!outcome) throw new Error("Private continuation is still running; its durable delivery will recover");
    if (outcome.status === "ok") {
      const text = toSlackMrkdwn(cleanAgentReplyForSlack(outcome.reply ?? "").text);
      if (outcome.attachments?.length) await uploadAttachments(client, dm, undefined, outcome.attachments, core);
      if (text)
        await postWithVerify(
          client,
          { ...slackReplyArgs(dm, text, undefined, { unfurlLinks: false }) },
          `run:${dmRunId}`,
          { verifyFirst: true, verifyOldest: source.triggerTs ?? "0" },
        );
    } else if (outcome.status === "failed" || outcome.status === "refused") {
      await postWithVerify(
        client,
        {
          ...slackReplyArgs(
            dm,
            `I couldn't finish the private continuation: ${userFacingFailureClause(outcome)}`,
            undefined,
          ),
        },
        `run:${dmRunId}`,
        { verifyFirst: true, verifyOldest: source.triggerTs ?? "0" },
      );
    }
    await core.ackRunDelivery(dmRunId);
  } finally {
    current.inFlightRuns?.delete(dmRunId);
  }
}
