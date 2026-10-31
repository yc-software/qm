import { createAckPresenter, type AckPresenter } from "../surfaces/ack-presenter.ts";
import { resolveDiscordEmoji } from "./emoji.ts";
import type { DiscordSender } from "./sender.ts";

export function createDiscordAck(
  sender: Pick<DiscordSender, "react" | "unreact">,
  trigger: { channelId: string; messageId: string },
): AckPresenter {
  const withEmoji = (name: string, apply: (emoji: string) => Promise<void>): Promise<void> => {
    const emoji = resolveDiscordEmoji(name);
    return emoji ? apply(emoji) : Promise.resolve();
  };
  return createAckPresenter({
    postAck: async () => {},
    addReaction: (name) => withEmoji(name, (emoji) => sender.react(trigger.channelId, trigger.messageId, emoji)),
    removeReaction: (name) => withEmoji(name, (emoji) => sender.unreact(trigger.channelId, trigger.messageId, emoji)),
  });
}
