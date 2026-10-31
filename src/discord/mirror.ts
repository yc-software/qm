import type { IngestEvent } from "../surface-cache/types.ts";
import { snowflakeMs } from "../util/snowflake.ts";
import { discordExternalId } from "./config.ts";
import type { DiscordInbound } from "./events.ts";

export function shouldMirror(msg: DiscordInbound, botUserId: string, staked: boolean): boolean {
  if (msg.guildId === null) return false;
  return msg.authorId === botUserId || msg.mentionedUserIds.includes(botUserId) || staked;
}

export function toIngestEvent(
  msg: DiscordInbound,
  botUserId: string,
  opts: { handled: boolean; createdAt: number; editedAt?: number },
): IngestEvent {
  return {
    container: msg.channelId,
    ts: msg.id,
    authorId: discordExternalId(msg.authorId),
    authorName: msg.authorName,
    text: msg.content,
    mentionsSelf: msg.mentionedUserIds.includes(botUserId),
    self: msg.authorId === botUserId,
    bot: msg.authorIsBot,
    handled: opts.handled,
    createdAt: opts.createdAt,
    kind: "channel",
    ...(opts.editedAt !== undefined ? { editedAt: opts.editedAt } : {}),
    ...(msg.channelName ? { containerName: msg.channelName } : {}),
  };
}

export function toEditEvent(msg: DiscordInbound, botUserId: string, editedAt: number): IngestEvent {
  return toIngestEvent(msg, botUserId, { handled: false, createdAt: snowflakeMs(msg.id), editedAt });
}

export function toDeleteEvent(container: string, id: string, self: boolean): IngestEvent {
  return { container, ts: id, deleted: true, kind: "channel", ...(self ? { self: true } : {}) };
}
