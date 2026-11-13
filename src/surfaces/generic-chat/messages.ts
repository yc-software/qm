import type { App } from "../../api/app-types.ts";
import type { IngestEvent } from "../../surface-cache/types.ts";
import type { SurfaceAction } from "../contract.ts";
import type { GenericChatClient } from "./client.ts";
import {
  GENERIC_CHAT,
  chatContainer,
  findMessage,
  genericChatMessageId,
  genericChatTs,
  type GenericChatRef,
} from "./protocol.ts";

const SELF_AUTHOR = "self";

export interface GenericChatMessages {
  client: GenericChatClient;
  app: Pick<App, "ingestSurfaceEvents" | "readSurfaceMessages">;
  now?: () => number;
}

type GenericChatWhere = Pick<GenericChatRef, "account" | "kind" | "chat">;

function ownPost(deps: GenericChatMessages, container: string, messageId: string) {
  return findMessage(
    { readMessages: (target, opts) => deps.app.readSurfaceMessages(target, opts) },
    container,
    messageId,
    { self: true, includeDeleted: true },
  );
}

function ownEvent(container: string, ts: string, createdAt: number): IngestEvent {
  return { surface: GENERIC_CHAT, container, ts, self: true, bot: true, handled: true, createdAt };
}

async function recordChange(
  deps: GenericChatMessages,
  where: GenericChatWhere,
  messageId: string,
  change: Pick<IngestEvent, "text" | "editedAt" | "deleted">,
): Promise<void> {
  const container = chatContainer(where);
  const own = await ownPost(deps, container, messageId);
  if (own)
    await deps.app.ingestSurfaceEvents([{ ...ownEvent(container, own.ts, own.createdAt), ...change }], GENERIC_CHAT);
}

export async function postGenericChatMessage(
  deps: GenericChatMessages,
  where: GenericChatRef,
  message: {
    text: string;
    idempotencyKey: string | undefined;
    fileIds?: readonly string[];
    actions?: readonly SurfaceAction[];
    recipientUserId?: string;
  },
): Promise<string | undefined> {
  const parsed = await deps.client.call(where.account, "/agent_app/messages", {
    client_message_id: message.idempotencyKey,
    chat_id: where.chat,
    ...(where.thread && !message.recipientUserId ? { thread_id: where.thread } : {}),
    body: message.text,
    ...(message.fileIds?.length ? { file_ids: message.fileIds } : {}),
    ...(message.actions?.length ? { actions: message.actions } : {}),
    ...(message.recipientUserId ? { recipient_user_id: message.recipientUserId } : {}),
  });
  if (typeof parsed.message_id !== "string" && typeof parsed.message_id !== "number") return undefined;
  const messageId = String(parsed.message_id);
  const container = chatContainer(where);
  const known = await ownPost(deps, container, messageId);
  if (known) return known.ts;
  const at = (deps.now ?? Date.now)();
  const ts = genericChatTs(new Date(at).toISOString(), messageId);
  if (message.recipientUserId) return ts;
  await deps.app.ingestSurfaceEvents(
    [{ ...ownEvent(container, ts, at), sub: where.thread ?? null, authorId: SELF_AUTHOR, text: message.text }],
    GENERIC_CHAT,
  );
  return ts;
}

export async function editGenericChatMessage(
  deps: GenericChatMessages,
  where: GenericChatWhere,
  ref: string,
  text: string,
  actions?: readonly SurfaceAction[],
): Promise<void> {
  const messageId = genericChatMessageId(ref);
  await deps.client.call(where.account, "/agent_app/messages/update", {
    chat_id: where.chat,
    message_id: messageId,
    body: text,
    ...(actions ? { actions } : {}),
  });
  await recordChange(deps, where, messageId, { text, editedAt: (deps.now ?? Date.now)() });
}

export async function deleteGenericChatMessage(
  deps: GenericChatMessages,
  where: GenericChatWhere,
  ref: string,
): Promise<void> {
  const messageId = genericChatMessageId(ref);
  await deps.client.call(where.account, "/agent_app/messages/delete", { chat_id: where.chat, message_id: messageId });
  await recordChange(deps, where, messageId, { deleted: true });
}

export async function setGenericChatTyping(
  client: GenericChatClient,
  where: Pick<GenericChatRef, "account" | "chat" | "thread">,
  on: boolean,
): Promise<void> {
  await client.call(where.account, "/agent_app/typing", {
    chat_id: where.chat,
    ...(where.thread ? { thread_id: where.thread } : {}),
    typing: on,
  });
}
