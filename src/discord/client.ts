import { GatewayIntentBits, Partials, type ClientOptions, type MessageCreateOptions } from "discord.js";
import { NO_MENTIONS } from "./sender.ts";
import type { ReplyChannel } from "./turn-flow.ts";

export const DISCORD_CLIENT_OPTIONS: ClientOptions = {
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  allowedMentions: NO_MENTIONS,
};

export function replyChannel(ch: {
  send(options: MessageCreateOptions): Promise<{
    id?: string;
    edit(content: string): Promise<unknown>;
    delete(): Promise<unknown>;
  }>;
  sendTyping?(): Promise<void>;
}): ReplyChannel {
  return {
    send: async (content, files) => {
      const sent = await ch.send({
        content: content || undefined,
        allowedMentions: NO_MENTIONS,
        ...(files?.length ? { files } : {}),
      });
      return {
        id: sent.id ?? "",
        edit: (c) => sent.edit(c),
        delete: () => sent.delete(),
      };
    },
    typing: async () => {
      if (typeof ch.sendTyping === "function") await ch.sendTyping();
    },
  };
}
