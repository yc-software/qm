import type { TenantSettings } from "../../tenants/settings.ts";
import { GenericChatHttpError } from "../generic-chat/client.ts";

export const TEAMS = "teams";
export const TEAMS_ACTION_KEY = "qm_action";

export type TeamsBot = NonNullable<TenantSettings["teams"]>;

const CHAT_TYPES = ["personal", "groupChat", "channel"] as const;
export type TeamsChatType = (typeof CHAT_TYPES)[number];

export function isTeamsChatType(value: unknown): value is TeamsChatType {
  return CHAT_TYPES.some((type) => type === value);
}

const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
const decode = (token: string): string => Buffer.from(token, "base64url").toString("utf8");

export function encodeTeamsChat(chat: { type: TeamsChatType; id: string }): string {
  return encode(`${chat.type}\n${chat.id}`);
}

export function decodeTeamsChat(token: string): { type: TeamsChatType; id: string } {
  const text = decode(token);
  const split = text.indexOf("\n");
  const type = text.slice(0, split);
  const id = text.slice(split + 1);
  if (split < 0 || !id || !isTeamsChatType(type)) throw new GenericChatHttpError(400, "teams: unknown chat");
  return { type, id };
}

export const encodeTeamsUser = encode;
export const decodeTeamsUser = decode;
