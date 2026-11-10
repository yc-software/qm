import type { LoopSourcePayload } from "../types.ts";
import { isObj } from "../sources/adapter.ts";
import { transcriptWindow, type Conversation, type TranscriptMessage } from "./transcript.ts";

export function waitingMessage(conversation: Conversation, waitingTs: string | null): TranscriptMessage | undefined {
  const { messages } = conversation;
  return (
    (waitingTs ? messages.find((message) => message.ts === waitingTs) : undefined) ??
    messages.findLast((message) => !message.owner) ??
    messages.at(-1)
  );
}

function previewText(message: TranscriptMessage | undefined): string {
  if (!message) return "";
  const text = message.text.trim();
  if (text) return text;
  if (message.images?.length)
    return message.images.length === 1 ? "Sent an image" : `Sent ${message.images.length} images`;
  if (message.attachments)
    return message.attachments === 1 ? "Sent an attachment" : `Sent ${message.attachments} attachments`;
  return "";
}

export function conversationPayload(
  existing: LoopSourcePayload | undefined,
  conversation: Conversation,
  waitingTs: string | null,
): LoopSourcePayload {
  const waiting = waitingMessage(conversation, waitingTs);
  const newest = conversation.messages.at(-1);
  const transcript = transcriptWindow(conversation);
  const partial = conversation.partial === true || transcript.length < conversation.messages.length;
  const existingSlack = isObj(existing?.slack) ? existing.slack : {};
  const existingGmail = isObj(existing?.gmail) ? existing.gmail : {};
  return {
    title: conversation.label,
    from: waiting?.author ?? "",
    ...(waiting?.authorDetail ? { fromDetail: waiting.authorDetail } : {}),
    snippet: previewText(waiting),
    receivedAt: newest?.at ?? Date.now(),
    ...(conversation.externalUrl ? { externalUrl: conversation.externalUrl } : {}),
    context: transcript.map((message) => ({
      author: message.author,
      ...(message.authorId ? { authorId: message.authorId } : {}),
      at: message.at,
      text: message.text,
      ...(message.images?.length ? { images: message.images } : {}),
    })),
    ...(waiting?.images?.length ? { images: waiting.images } : {}),
    ...(partial ? { sourceContextPartial: true } : {}),
    ...(conversation.participants ? { participants: conversation.participants } : {}),
    ...(existing?.sentChat === true ? { sentChat: true } : {}),
    ...(Array.isArray(existing?.reactions) ? { reactions: existing.reactions } : {}),
    ...(conversation.slack
      ? {
          slack: {
            ...existingSlack,
            ...conversation.slack,
            ...(waiting ? { ts: waiting.ts } : {}),
            ...(waiting?.authorId ? { userId: waiting.authorId } : {}),
          },
        }
      : {}),
    ...(conversation.gmail
      ? {
          gmail: {
            ...existingGmail,
            ...conversation.gmail,
            ...(waiting?.reply
              ? {
                  messageId: waiting.reply.messageId,
                  ...(waiting.reply.rfcMessageId ? { rfcMessageId: waiting.reply.rfcMessageId } : {}),
                  to: waiting.reply.to,
                  cc: waiting.reply.cc,
                }
              : {}),
          },
        }
      : {}),
  };
}

export function draftData(
  conversation: Conversation,
  waiting: TranscriptMessage | undefined,
  body: string,
): LoopSourcePayload {
  if (conversation.source === "gmail" && waiting?.reply)
    return { body, to: waiting.reply.to, ...(waiting.reply.cc.length ? { cc: waiting.reply.cc } : {}) };
  return { body };
}
