import { EMOJI_CHAR_BY_NAME, emojiNameOf } from "../../slack/emoji-map.ts";
import { normalizeReaction } from "../../slack/reactions.ts";
import type { GenericChatClient } from "./client.ts";
import { genericChatMessageId, type GenericChatRef } from "./protocol.ts";

const SKIN_TONE = "::skin-tone-";

export class UnknownGenericChatReaction extends Error {
  constructor(name: string) {
    super(`generic-chat: no emoji is named ${JSON.stringify(name.slice(0, 80))}`);
  }
}

function genericChatReactionName(raw: string): { name: string; char: string; skin_tone?: number } | null {
  const [alias, tone] = (normalizeReaction(raw) ?? "").split(SKIN_TONE);
  const char = alias ? EMOJI_CHAR_BY_NAME[alias] : undefined;
  if (!alias || !char) return null;
  return { name: emojiNameOf(char) ?? alias, char, ...(tone ? { skin_tone: Number(tone) } : {}) };
}

export async function setGenericChatReaction(
  client: GenericChatClient,
  where: Pick<GenericChatRef, "account" | "chat">,
  ref: string,
  name: string,
  on: boolean,
): Promise<void> {
  const reaction = genericChatReactionName(name);
  if (!reaction) throw new UnknownGenericChatReaction(name);
  const { char, ...named } = reaction;
  await client.react(
    where.account,
    { chat_id: where.chat, message_id: genericChatMessageId(ref), ...named },
    { on, emoji: char },
  );
}
