import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { KeychainApprovalView } from "../credentials/keychain-approval.ts";
import type { Directory } from "./directory.ts";
import { parseBlockAction, parseInteractionBody } from "./payloads.ts";
import { updateSlackMessage } from "./messaging.ts";
import { findPostedByKey, postWithVerify, slackReplyArgs } from "./delivery.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { parseScopeId } from "../types.ts";

const ACTIONS = ["keychain_allow_once", "keychain_allow_always", "keychain_deny"] as const;
const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function keychainApprovalMessage(
  view: KeychainApprovalView,
  originUrl?: string,
): { text: string; blocks: Array<Record<string, unknown>> } {
  const { ask } = view;
  const place = `in ${escape(view.conversation).replaceAll("|", "&#124;")}`;
  const origin =
    originUrl && /^https?:\/\//.test(originUrl)
      ? `<${originUrl.replaceAll("|", "%7C").replaceAll(">", "%3E")}|${place}>`
      : place;
  const pending = ask.status === "pending";
  const { kind } = parseScopeId(ask.requesterScopeId);
  let audience = "this group";
  if (kind === "personal") audience = "your personal conversations";
  if (kind === "channel") audience = "this channel";
  const standing = `ongoing access across ${audience}`;
  const duration = pending ? ` (${ask.requestedMode === "once" ? "one-time access" : standing})` : "";
  const summary = `Use your *${escape(view.service.slice(0, 150))}* credential ${origin}${duration}.`;
  let status = "This request expired.";
  if (ask.status === "approved") status = `Approved — ${view.mode === "standing" ? standing : "one-time access"}.`;
  if (ask.status === "declined") status = "Denied.";
  const text = pending
    ? `Approval needed: use your ${view.service} credential in ${view.conversation}${duration}.`
    : status;
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${pending ? ":lock: *Approval needed.*" : `*${status}*`}\n${summary}`,
      },
    },
  ];
  if (pending) {
    blocks.push({
      type: "actions",
      block_id: `keychain_ask:${ask.id}`,
      elements: [
        ...(ask.requestedMode === "once" ? [ACTIONS[0], ACTIONS[1]] : [ACTIONS[1], ACTIONS[0]]).map((id, i) => ({
          type: "button",
          text: { type: "plain_text", text: id === ACTIONS[0] ? "Allow once" : "Allow" },
          action_id: id,
          value: ask.id,
          ...(i === 0 ? { style: "primary" } : {}),
        })),
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          action_id: ACTIONS[2],
          value: ask.id,
          style: "danger",
        },
      ],
    });
  }
  return { text, blocks };
}

export async function keychainApprovalOrigin(
  view: KeychainApprovalView,
  client: any,
  webUrl?: string,
): Promise<string | undefined> {
  if (view.slack) {
    const result = await client.chat
      .getPermalink({ channel: view.slack.channel, message_ts: view.slack.ts })
      .catch(swallowAs("slack: approval origin link", null));
    if (typeof result?.permalink === "string") return result.permalink;
  }
  if (!webUrl || !view.sessionId) return undefined;
  const url = new URL(`${webUrl.replace(/\/+$/, "")}/s/${encodeURIComponent(view.sessionId)}`);
  if (view.seq !== undefined) url.searchParams.set("seq", String(view.seq));
  return url.toString();
}

// Posts the approval card in the requesting conversation; a later `ask:<id>:resolved` delivery
// finds that card and updates it in place, so a decision made on the web shows here too.
export async function deliverKeychainCard(
  core: SlackCoreClient,
  client: any,
  delivery: { idempotencyKey?: string; destination: { keychainAskId?: string } },
  channel: string,
  threadTs: string | undefined,
  webUrl?: string,
): Promise<void> {
  const id = delivery.destination.keychainAskId!;
  const view = await core.keychainApprovals?.card(id);
  if (!view) return;
  const card = keychainApprovalMessage(view, await keychainApprovalOrigin(view, client, webUrl));
  const key = `ask:${id}:notice`;
  if (delivery.idempotencyKey === key) {
    await postWithVerify(client, { ...slackReplyArgs(channel, card.text, threadTs), blocks: card.blocks }, key, {
      verifyFirst: true,
    });
    return;
  }
  const where = { channel, ...(threadTs ? { thread_ts: threadTs } : {}) };
  const posted = await findPostedByKey(client, where, key, String((view.ask.createdAt - 60_000) / 1000));
  if (posted) await updateSlackMessage(client, channel, posted.ts, card.text, card.blocks);
}

export function registerKeychainApprovalActions(
  app: { action(pattern: RegExp, handler: (args: any) => Promise<void>): void },
  deps: { core: SlackCoreClient; directory: Directory; webUiPublicUrl?: string },
): void {
  app.action(/^keychain_/, async ({ ack, body, action, client }) => {
    await ack();
    const parsed = parseBlockAction(action, ACTIONS);
    const { clickerId, channel, messageTs } = parseInteractionBody(body);
    if (!parsed || !clickerId || !channel || !messageTs || !deps.core.keychainApprovals) return;
    try {
      const actor = await deps.directory.classifyActor(client, clickerId);
      if (actor.identityFailure) throw new Error("the approver identity could not be resolved");
      const decisions = {
        keychain_allow_once: "once",
        keychain_allow_always: "standing",
        keychain_deny: "deny",
      } as const;
      const decision = decisions[parsed.actionId as keyof typeof decisions];
      const view = await deps.core.keychainApprovals.decide(parsed.value, actor, decision);
      const origin = await keychainApprovalOrigin(view, client, deps.webUiPublicUrl);
      const card = keychainApprovalMessage(view, origin);
      await updateSlackMessage(client, channel, messageTs, card.text, card.blocks);
    } catch (error) {
      await client.chat
        .postEphemeral({
          channel,
          user: clickerId,
          text: `Couldn't complete this approval: ${errMessage(error)} You can try the button again.`,
        })
        .catch(swallowAs("slack: credential approval failure", undefined));
    }
  });
}
