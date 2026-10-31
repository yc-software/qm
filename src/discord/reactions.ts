import { emojiNameOf } from "../surfaces/emoji-map.ts";
import { countedReactions, type ReactionTally } from "../surfaces/reaction-tally.ts";
import { MAX_REACTIONS_PER_TURN } from "../surfaces/reactions.ts";
import { swallowAs } from "../util/errors.ts";
import { resolveDiscordEmoji } from "./emoji.ts";
import type { DiscordSender } from "./sender.ts";

export interface MessageTarget {
  channelId: string;
  messageId: string;
}

interface EmojiFacts {
  name: string | null;
  id: string | null;
  animated?: boolean | null;
}

export function emojiDisplayName(emoji: EmojiFacts): string {
  const name = emoji.name ?? "";
  return emoji.id ? `<${emoji.animated ? "a" : ""}:${name}:${emoji.id}>` : (emojiNameOf(name) ?? name);
}

export function reactionTallies(reactions: Iterable<{ emoji: EmojiFacts; count: number | null }>): ReactionTally[] {
  return countedReactions([...reactions].map((r) => ({ name: emojiDisplayName(r.emoji), count: r.count ?? 0 })));
}

export async function applyDiscordReactions(
  sender: Pick<DiscordSender, "react">,
  target: MessageTarget,
  names: readonly string[],
): Promise<{ added: string[]; failed: string[] }> {
  const added: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (added.length + failed.length >= MAX_REACTIONS_PER_TURN) break;
    const emoji = resolveDiscordEmoji(name);
    if (emoji && seen.has(emoji)) continue;
    if (emoji) seen.add(emoji);
    const landed =
      emoji !== null &&
      (await sender
        .react(target.channelId, target.messageId, emoji)
        .then(() => true)
        .catch(swallowAs("discord: reaction", false)));
    (landed ? added : failed).push(name);
  }
  return { added, failed };
}
