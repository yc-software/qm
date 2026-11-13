import type { SurfaceAction } from "../contract.ts";
import type { PartnerChatClient } from "./client.ts";

export interface PartnerChatPost {
  account: string;
  chat: string;
  thread?: string;
  body: string;
  clientMessageId: string;
  actions?: readonly SurfaceAction[];
  recipientUserId?: string;
}

export async function postPartnerChatMessage(
  client: PartnerChatClient,
  post: PartnerChatPost,
): Promise<string | undefined> {
  const parsed = await client.call(post.account, "/agent_app/messages", {
    client_message_id: post.clientMessageId,
    chat_id: post.chat,
    ...(post.thread ? { thread_id: post.thread } : {}),
    body: post.body,
    ...(post.actions?.length ? { actions: post.actions } : {}),
    ...(post.recipientUserId ? { recipient_user_id: post.recipientUserId } : {}),
  });
  const messageId = parsed.message_id;
  return typeof messageId === "string" || typeof messageId === "number" ? String(messageId) : undefined;
}

export async function setPartnerChatMessageActions(
  client: PartnerChatClient,
  message: { account: string; chat: string; messageId: string; body: string; actions: readonly SurfaceAction[] },
): Promise<void> {
  await client.call(message.account, "/agent_app/messages/update", {
    chat_id: message.chat,
    message_id: message.messageId,
    body: message.body,
    actions: message.actions,
  });
}
