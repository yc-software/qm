import { MessageReferenceType, type Message } from "discord.js";
import { appendRenderedLines, bracketedLine, forwardLabel, MAX_RENDERED_FORWARDS } from "../surfaces/forwards.ts";
import { swallow } from "../util/errors.ts";
import { clipMessage, SELF_AUTHOR } from "../surfaces/conversation.ts";
import type { DiscordAttachmentRef } from "./events.ts";

interface AttachmentSource {
  values(): Iterable<DiscordAttachmentRef>;
}

interface SnapshotLike {
  content?: string | null;
  attachments: AttachmentSource;
}

export function attachmentRefs(attachments: AttachmentSource): DiscordAttachmentRef[] {
  return [...attachments.values()].map((a) => ({ url: a.url, name: a.name, contentType: a.contentType, size: a.size }));
}

export function withForwardedContent(
  content: string,
  snapshots: Iterable<SnapshotLike>,
): { text: string; attachments: DiscordAttachmentRef[] } {
  const kept = [...snapshots].slice(0, MAX_RENDERED_FORWARDS);
  const lines = kept.map((s) => bracketedLine(forwardLabel({}), (s.content ?? "").trim()));
  return {
    text: appendRenderedLines(content, lines),
    attachments: kept.flatMap((s) => attachmentRefs(s.attachments)),
  };
}

export async function withReplyContext(message: Message, text: string, botUserId: string): Promise<string> {
  const ref = message.reference;
  if (!ref?.messageId || ref.type === MessageReferenceType.Forward) return text;
  let parent: Message;
  try {
    parent = await message.fetchReference();
  } catch (err) {
    swallow("discord: reply reference", err);
    return text;
  }
  const author =
    parent.author.id === botUserId
      ? SELF_AUTHOR
      : (parent.member?.displayName ?? parent.author.globalName ?? parent.author.username);
  return `${bracketedLine(`in reply to ${author}`, clipMessage(parent.content))}\n${text}`;
}
