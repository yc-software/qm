import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { KeychainApprovalView } from "../credentials/keychain-approval.ts";
import type { Directory } from "./directory.ts";
import { parseBlockAction, parseInteractionBody } from "./payloads.ts";
import { updateSlackMessage } from "./messaging.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

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
  const summary = `Use your *${escape(view.service.slice(0, 150))}* credential ${origin}.`;
  const pending = ask.status === "pending";
  let status = "This request expired.";
  if (ask.status === "approved")
    status = `Approved — ${view.mode === "standing" ? "ongoing access for this conversation" : "one-time access"}.`;
  if (ask.status === "declined") status = "Denied.";
  const text = pending
    ? `Approval needed: use your ${view.service} credential in ${view.conversation}. ${ask.purpose}`
    : status;
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${pending ? ":lock: *Approval needed.*" : `*${status}*`}\n${summary}\n*Why:* ${escape(ask.purpose.slice(0, 900))}`,
      },
    },
  ];
  if (pending) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: "Allow once permits one credential use. Allow always permits future use in this conversation until revoked.",
        },
      ],
    });
    blocks.push({
      type: "actions",
      block_id: `keychain_ask:${ask.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Allow once" },
          action_id: ACTIONS[0],
          value: ask.id,
          style: "primary",
        },
        { type: "button", text: { type: "plain_text", text: "Allow always" }, action_id: ACTIONS[1], value: ask.id },
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
