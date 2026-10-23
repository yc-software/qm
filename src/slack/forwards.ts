import type { SlackFile } from "./attachments.ts";

const MAX_RENDERED_FORWARDS = 5;
const MAX_FORWARD_DEPTH = 4;
const MAX_LEGACY_ATTACHMENTS = 5;
const MAX_LEGACY_ATTACHMENT_CHARS = 2_000;

interface ForwardedMessage {
  text?: string;
  files?: SlackFile[];
  attachments?: SlackMessageAttachment[];
}

interface SlackMessageBlock {
  message?: ForwardedMessage;
}

interface SlackMessageAttachment extends ForwardedMessage {
  fallback?: string;
  author_name?: string;
  author_subname?: string;
  author_id?: string;
  channel_name?: string;
  channel_id?: string;
  is_msg_unfurl?: boolean;
  is_share?: boolean;
  from_url?: string;
  original_url?: string;
  pretext?: string;
  title?: string;
  title_link?: string;
  fields?: Array<{ title?: unknown; value?: unknown }>;
  footer?: string;
  ts?: string | number;
  message_blocks?: SlackMessageBlock[];
}

function isForwardedAttachment(attachment: SlackMessageAttachment): boolean {
  return attachment.is_msg_unfurl === true || attachment.is_share === true;
}

function isLinkPreview(attachment: SlackMessageAttachment): boolean {
  return Boolean(attachment.from_url || attachment.original_url);
}

function legacyAttachmentText(attachment: SlackMessageAttachment): string {
  const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const title = str(attachment.title);
  const parts = [
    str(attachment.pretext),
    title && str(attachment.title_link) ? `${title} (${str(attachment.title_link)})` : title,
    str(attachment.text),
    ...(Array.isArray(attachment.fields) ? attachment.fields : []).flatMap((field) => {
      const name = str(field?.title);
      const value = str(field?.value);
      if (!value) return [];
      return [name ? `${name}: ${value}` : value];
    }),
    str(attachment.footer),
  ].filter(Boolean);
  const body = parts.length ? parts.join("\n") : str(attachment.fallback);
  return body.length > MAX_LEGACY_ATTACHMENT_CHARS ? `${body.slice(0, MAX_LEGACY_ATTACHMENT_CHARS)}…` : body;
}

function nestedMessages(attachment: SlackMessageAttachment): ForwardedMessage[] {
  const messages = (attachment.message_blocks ?? []).flatMap((block) =>
    block?.message && typeof block.message === "object" ? [block.message] : [],
  );
  return attachment.attachments?.length ? [...messages, { attachments: attachment.attachments }] : messages;
}

export function messageWithForwardedContent(message: ForwardedMessage): { text: string; files: SlackFile[] } {
  const rendered: string[] = [];
  const files: SlackFile[] = [];
  const seenFiles = new Set<string>();
  let renderedForwards = 0;
  let renderedLegacy = 0;
  const base = String(message.text ?? "");

  const addFile = (file: SlackFile, authorId?: string): void => {
    if (!file || typeof file !== "object") return;
    if (file.id && seenFiles.has(file.id)) return;
    if (file.id) seenFiles.add(file.id);
    files.push(file.user || !authorId ? file : { ...file, user: authorId });
  };

  const visit = (current: ForwardedMessage, depth: number): void => {
    if (depth > MAX_FORWARD_DEPTH) return;
    for (const attachment of Array.isArray(current.attachments) ? current.attachments : []) {
      if (!attachment || typeof attachment !== "object") continue;
      if (!isForwardedAttachment(attachment)) {
        if (base.trim() || depth > 0 || isLinkPreview(attachment) || renderedLegacy >= MAX_LEGACY_ATTACHMENTS) continue;
        const body = legacyAttachmentText(attachment);
        if (!body) continue;
        renderedLegacy += 1;
        rendered.push(body);
        continue;
      }
      if (renderedForwards >= MAX_RENDERED_FORWARDS) return;
      renderedForwards += 1;

      const author = attachment.author_subname || attachment.author_name || attachment.author_id;
      let channel: string | undefined;
      if (attachment.channel_name) channel = `#${attachment.channel_name}`;
      else if (attachment.channel_id) channel = `channel ${attachment.channel_id}`;
      const label = `forwarded message${author ? ` from ${author}` : ""}${channel ? ` in ${channel}` : ""}`;
      const body = String(attachment.text || attachment.fallback || "").trim();
      rendered.push(body ? `[${label}] ${body}` : `[${label}]`);

      for (const file of Array.isArray(attachment.files) ? attachment.files : []) addFile(file, attachment.author_id);
      for (const nested of nestedMessages(attachment)) visit(nested, depth + 1);
    }
  };

  for (const file of Array.isArray(message.files) ? message.files : []) addFile(file);
  visit(message, 0);

  let text = base;
  if (rendered.length) text = base ? `${base}\n${rendered.join("\n")}` : rendered.join("\n");
  return { text, files };
}
