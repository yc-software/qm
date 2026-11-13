import { extractPrivateContinuation } from "./external-access.ts";
import {
  type ReactionDirective,
  SLACK_TEXT_LIMIT,
  applyReactions,
  botIdentityArgs,
  extractReactions,
  stripReactionDirectives,
} from "./lib.ts";
import { withinReactionBudget } from "../surfaces/reactions.ts";

import type { SlackConversationKind } from "./message-gating.ts";
export type { SlackConversationKind } from "./message-gating.ts";

export async function updateSlackMessage(
  client: any,
  channel: string,
  ts: string | undefined,
  text: string,
  blocks?: Array<Record<string, unknown>>,
): Promise<boolean> {
  if (!ts) return false;
  await client.chat.update({
    channel,
    ts,
    text: text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT - 1)}…` : text,
    ...botIdentityArgs(),
    unfurl_links: false,
    unfurl_media: false,
    blocks: blocks ?? [],
  });
  return true;
}

export function cleanAgentReplyForSlack(text: string): { text: string; reactions: ReactionDirective[] } {
  const extracted = extractReactions(text);
  return { text: extractPrivateContinuation(extracted.text).text, reactions: extracted.reactions };
}

export function stripSlackDirectives(text: string): string {
  return extractPrivateContinuation(stripReactionDirectives(text)).text;
}

export async function applyAndLogReactions(
  client: any,
  channel: string,
  defaultTs: string | undefined,
  directives: readonly ReactionDirective[],
): Promise<void> {
  for (const d of withinReactionBudget(directives.filter((r) => r.target ?? defaultTs))) {
    const timestamp = (d.target ?? defaultTs)!;
    const { failed } = await applyReactions(client, channel, timestamp, d.names);
    if (failed.length) {
      console.error(
        `[slack-plugin] couldn't add reaction(s): ${failed.join(", ")} on ${timestamp} (check the reactions:write scope / message ts)`,
      );
    }
  }
}

export function conversationPlaceLabel(
  kind: SlackConversationKind,
  channelName: string | undefined,
  channel: string,
): string {
  if (kind === "group") return channelName ? `group DM (${channelName})` : "group DM";
  return channelName ? `#${channelName}` : `channel ${channel}`;
}
