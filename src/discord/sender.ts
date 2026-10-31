import { RESTJSONErrorCodes, type Client, type Message, type MessageCreateOptions } from "discord.js";
import type { DiscordFile } from "./attachments.ts";
import { SNOWFLAKE } from "../util/snowflake.ts";
import type { DiscordChannels } from "./gateway.ts";

export class InvalidMessageIdError extends Error {}

function rawMessageId(id: string): string {
  if (!SNOWFLAKE.test(id)) throw new InvalidMessageIdError(`"${id}" is not a message id from this conversation`);
  return id;
}

export const NO_MENTIONS = { parse: [] as [], repliedUser: false as const };

export interface OutboundMessage {
  content?: string;
  files?: DiscordFile[];
  replyTo?: string;
  components?: MessageCreateOptions["components"];
}

export interface DiscordSender {
  send(channelId: string, msg: OutboundMessage): Promise<{ id: string }>;
  edit(
    channelId: string,
    messageId: string,
    msg: { content: string; components?: MessageCreateOptions["components"] },
  ): Promise<void>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  unreact(channelId: string, messageId: string, emoji: string): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
  openDm(userId: string): Promise<string>;
}

export type SendableChannel = {
  parentId?: string | null;
  isTextBased(): boolean;
  send(options: MessageCreateOptions): Promise<Message>;
  sendTyping?(): Promise<void>;
  messages: {
    fetch(id: string): Promise<Message>;
    edit(id: string, options: MessageCreateOptions): Promise<Message>;
    delete(id: string): Promise<unknown>;
  };
};

function isSendableChannel(ch: unknown): ch is SendableChannel {
  return Boolean(
    ch &&
    typeof ch === "object" &&
    "isTextBased" in ch &&
    typeof (ch as { isTextBased: unknown }).isTextBased === "function" &&
    (ch as { isTextBased(): boolean }).isTextBased() &&
    "send" in ch,
  );
}

export async function sendable(channels: DiscordChannels, channelId: string): Promise<SendableChannel> {
  const ch = await channels.fetch(channelId);
  if (!isSendableChannel(ch)) throw new Error(`discord channel ${channelId} is not sendable`);
  return ch;
}

export function createDiscordSender(client: Pick<Client, "users" | "user">, channels: DiscordChannels): DiscordSender {
  return {
    async send(channelId, msg) {
      const ch = await sendable(channels, channelId);
      const sent = await ch.send({
        allowedMentions: NO_MENTIONS,
        ...(msg.content ? { content: msg.content } : {}),
        ...(msg.files?.length ? { files: msg.files } : {}),
        ...(msg.components ? { components: msg.components } : {}),
        ...(msg.replyTo ? { reply: { messageReference: msg.replyTo, failIfNotExists: false } } : {}),
      });
      return { id: sent.id };
    },
    async edit(channelId, ref, msg) {
      const messageId = rawMessageId(ref);
      const ch = await sendable(channels, channelId);
      await ch.messages.edit(messageId, {
        content: msg.content,
        allowedMentions: NO_MENTIONS,
        components: msg.components ?? [],
      });
    },
    async react(channelId, ref, emoji) {
      const messageId = rawMessageId(ref);
      const ch = await sendable(channels, channelId);
      const msg = await ch.messages.fetch(messageId).catch(async (err: unknown) => {
        if ((err as { code?: number }).code !== RESTJSONErrorCodes.UnknownMessage || !ch.parentId) throw err;
        return (await sendable(channels, ch.parentId)).messages.fetch(messageId);
      });
      await msg.react(emoji);
    },
    async unreact(channelId, ref, emoji) {
      const messageId = rawMessageId(ref);
      const ch = await sendable(channels, channelId);
      await (await ch.messages.fetch(messageId)).reactions.resolve(emoji)?.users.remove();
    },
    async remove(channelId, ref) {
      const messageId = rawMessageId(ref);
      const ch = await sendable(channels, channelId);
      const msg = await ch.messages.fetch(messageId);
      if (msg.author.id !== client.user?.id) throw new Error("I can only delete my own Discord messages.");
      await msg.delete();
    },
    async openDm(userId) {
      const dm = await (await client.users.fetch(userId)).createDM();
      return dm.id;
    },
  };
}
