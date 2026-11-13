import { EMOJI_CHAR_BY_NAME, emojiNameOf } from "../../slack/emoji-map.ts";
import { normalizeReaction } from "../../slack/reactions.ts";
import type { PartnerChatClient } from "./client.ts";
import { partnerChatMessageId, type PartnerChatRef } from "./protocol.ts";

const SKIN_TONE = "::skin-tone-";

export class UnknownPartnerChatReaction extends Error {
  constructor(name: string) {
    super(`partner-chat: no emoji is named ${JSON.stringify(name.slice(0, 80))}`);
  }
}

function partnerChatReactionName(raw: string): { name: string; skin_tone?: number } | null {
  const [alias, tone] = (normalizeReaction(raw) ?? "").split(SKIN_TONE);
  const char = alias ? EMOJI_CHAR_BY_NAME[alias] : undefined;
  if (!alias || !char) return null;
  return { name: emojiNameOf(char) ?? alias, ...(tone ? { skin_tone: Number(tone) } : {}) };
}

export async function setPartnerChatReaction(
  client: PartnerChatClient,
  where: Pick<PartnerChatRef, "account" | "chat">,
  ref: string,
  name: string,
  on: boolean,
): Promise<void> {
  const reaction = partnerChatReactionName(name);
  if (!reaction) throw new UnknownPartnerChatReaction(name);
  await client.call(where.account, on ? "/agent_app/reactions/add" : "/agent_app/reactions/remove", {
    chat_id: where.chat,
    message_id: partnerChatMessageId(ref),
    ...reaction,
  });
}
