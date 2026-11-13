import type { App } from "../../api/app-types.ts";
import type { PartnerChatClient } from "./client.ts";
import { partnerChatRef, partnerChatTs, type PartnerChatRef } from "./protocol.ts";

const SELF_AUTHOR = "self";

export interface PartnerChatPoster {
  client: PartnerChatClient;
  app: Pick<App, "ingestSurfaceEvents">;
  now?: () => number;
}

export async function postPartnerChatMessage(
  deps: PartnerChatPoster,
  post: { chat: Omit<PartnerChatRef, "thread">; thread?: string; body: string; key: string; recipientUserId?: string },
): Promise<string | undefined> {
  const { chat, thread, body } = post;
  const parsed = await deps.client.call(chat.account, "/agent_app/messages", {
    client_message_id: post.key,
    chat_id: chat.chat,
    ...(thread ? { thread_id: thread } : {}),
    ...(post.recipientUserId ? { recipient_user_id: post.recipientUserId } : {}),
    body,
  });
  const messageId = parsed.message_id;
  if (typeof messageId !== "string" && typeof messageId !== "number") return undefined;
  const at = (deps.now ?? Date.now)();
  const ts = partnerChatTs(new Date(at).toISOString(), String(messageId));
  if (post.recipientUserId) return ts;
  await deps.app.ingestSurfaceEvents(
    [
      {
        surface: "partner-chat",
        container: partnerChatRef({ account: chat.account, kind: chat.kind, chat: chat.chat }),
        ts,
        sub: thread ?? null,
        authorId: SELF_AUTHOR,
        text: body,
        self: true,
        bot: true,
        handled: true,
        createdAt: at,
      },
    ],
    "partner-chat",
  );
  return ts;
}
