import { extractPrivateContinuation } from "./external-access.ts";
import { safeClip } from "./safe-cut.ts";
import {
  type ReactionDirective,
  MAX_REACTIONS_PER_TURN,
  SLACK_TEXT_LIMIT,
  applyReactions,
  botIdentityArgs,
  extractReactions,
  stripReactionDirectives,
} from "./lib.ts";

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
    text: safeClip(text, SLACK_TEXT_LIMIT - 1),
    ...botIdentityArgs(),
    unfurl_links: false,
    unfurl_media: false,
    blocks: blocks ?? [],
  });
  return true;
}

export const HANDOFF_INSTRUCTION =
  "When work needs another person's own logins, files or memory, follow the `hand-off` skill.";

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
  let budget = MAX_REACTIONS_PER_TURN;
  for (const d of directives) {
    if (budget <= 0) break;
    const timestamp = d.target ?? defaultTs;
    if (!d.names.length || !timestamp) continue;
    const { added, failed } = await applyReactions(client, channel, timestamp, d.names.slice(0, budget));
    budget -= added.length + failed.length;
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
