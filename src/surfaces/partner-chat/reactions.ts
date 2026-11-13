import { EMOJI_CHAR_BY_NAME, EMOJI_NAME_BY_CHAR } from "../../slack/emoji-map.ts";
import { normalizeReaction } from "../../slack/reactions.ts";
import type { PartnerChatClient } from "./client.ts";

const VARIATION_SELECTOR_16 = /\uFE0F/g;
const SKIN_TONE = "::skin-tone-";

export class UnknownPartnerChatReaction extends Error {
  constructor(name: string) {
    super(`partner-chat: no emoji is named ${JSON.stringify(name.slice(0, 80))}`);
  }
}

export interface PartnerChatMessageIds {
  account: string;
  chat: string;
  messageId: string;
}

export function partnerChatReactionName(raw: string): { name: string; skin_tone?: number } | null {
  const [alias, tone] = (normalizeReaction(raw) ?? "").split(SKIN_TONE);
  const char = alias ? EMOJI_CHAR_BY_NAME[alias] : undefined;
  if (!alias || !char) return null;
  return {
    name: EMOJI_NAME_BY_CHAR[char.replace(VARIATION_SELECTOR_16, "")] ?? alias,
    ...(tone ? { skin_tone: Number(tone) } : {}),
  };
}

async function setReaction(
  client: PartnerChatClient,
  path: "/agent_app/reactions/add" | "/agent_app/reactions/remove",
  ids: PartnerChatMessageIds,
  name: string,
): Promise<void> {
  const reaction = partnerChatReactionName(name);
  if (!reaction) throw new UnknownPartnerChatReaction(name);
  await client.call(ids.account, path, { chat_id: ids.chat, message_id: ids.messageId, ...reaction });
}

export function addPartnerChatReaction(
  client: PartnerChatClient,
  ids: PartnerChatMessageIds,
  name: string,
): Promise<void> {
  return setReaction(client, "/agent_app/reactions/add", ids, name);
}

export function removePartnerChatReaction(
  client: PartnerChatClient,
  ids: PartnerChatMessageIds,
  name: string,
): Promise<void> {
  return setReaction(client, "/agent_app/reactions/remove", ids, name);
}
