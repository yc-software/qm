import type { App } from "../../api/app-types.ts";
import type { SurfaceAction } from "../contract.ts";
import type { IngestEvent } from "../../surface-cache/types.ts";
import type { PartnerChatClient } from "./client.ts";
import { findMessage, partnerChatMessageId, partnerChatRef, partnerChatTs, type PartnerChatRef } from "./protocol.ts";

const SURFACE = "partner-chat";
const SELF_AUTHOR = "self";

export interface PartnerChatMessages {
  client: PartnerChatClient;
  app: Pick<App, "ingestSurfaceEvents" | "readSurfaceMessages">;
  now?: () => number;
}

type PartnerChatWhere = Pick<PartnerChatRef, "account" | "kind" | "chat">;

function ownPost(deps: PartnerChatMessages, container: string, messageId: string) {
  return findMessage(
    { readMessages: (target, opts) => deps.app.readSurfaceMessages(target, opts) },
    container,
    messageId,
    { self: true, includeDeleted: true },
  );
}

function ownEvent(container: string, ts: string, createdAt: number): IngestEvent {
  return { surface: SURFACE, container, ts, self: true, bot: true, handled: true, createdAt };
}

async function recordChange(
  deps: PartnerChatMessages,
  where: PartnerChatWhere,
  messageId: string,
  change: Pick<IngestEvent, "text" | "editedAt" | "deleted">,
): Promise<void> {
  const container = partnerChatRef({ account: where.account, kind: where.kind, chat: where.chat });
  const own = await ownPost(deps, container, messageId);
  if (own) await deps.app.ingestSurfaceEvents([{ ...ownEvent(container, own.ts, own.createdAt), ...change }], SURFACE);
}

export async function postPartnerChatMessage(
  deps: PartnerChatMessages,
  where: PartnerChatRef,
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
    ...(where.thread ? { thread_id: where.thread } : {}),
    body: message.text,
    ...(message.fileIds?.length ? { file_ids: message.fileIds } : {}),
    ...(message.actions?.length ? { actions: message.actions } : {}),
    ...(message.recipientUserId ? { recipient_user_id: message.recipientUserId } : {}),
  });
  if (typeof parsed.message_id !== "string" && typeof parsed.message_id !== "number") return undefined;
  const messageId = String(parsed.message_id);
  const container = partnerChatRef({ account: where.account, kind: where.kind, chat: where.chat });
  const known = await ownPost(deps, container, messageId);
  if (known) return known.ts;
  const at = (deps.now ?? Date.now)();
  const ts = partnerChatTs(new Date(at).toISOString(), messageId);
  if (message.recipientUserId) return ts;
  await deps.app.ingestSurfaceEvents(
    [{ ...ownEvent(container, ts, at), sub: where.thread ?? null, authorId: SELF_AUTHOR, text: message.text }],
    SURFACE,
  );
  return ts;
}

export async function editPartnerChatMessage(
  deps: PartnerChatMessages,
  where: PartnerChatWhere,
  ref: string,
  text: string,
): Promise<void> {
  const messageId = partnerChatMessageId(ref);
  await deps.client.call(where.account, "/agent_app/messages/update", {
    chat_id: where.chat,
    message_id: messageId,
    body: text,
  });
  await recordChange(deps, where, messageId, { text, editedAt: (deps.now ?? Date.now)() });
}

export async function deletePartnerChatMessage(
  deps: PartnerChatMessages,
  where: PartnerChatWhere,
  ref: string,
): Promise<void> {
  const messageId = partnerChatMessageId(ref);
  await deps.client.call(where.account, "/agent_app/messages/delete", { chat_id: where.chat, message_id: messageId });
  await recordChange(deps, where, messageId, { deleted: true });
}

export async function setPartnerChatTyping(
  client: PartnerChatClient,
  where: Pick<PartnerChatRef, "account" | "chat" | "thread">,
  on: boolean,
): Promise<void> {
  await client.call(where.account, "/agent_app/typing", {
    chat_id: where.chat,
    ...(where.thread ? { thread_id: where.thread } : {}),
    typing: on,
  });
}
