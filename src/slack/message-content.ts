import type { SlackFile } from "./attachments.ts";

const MAX_RENDERED_FORWARDS = 5;
const MAX_FORWARD_DEPTH = 4;

interface SlackMessageContent {
  text?: string;
  files?: SlackFile[];
  blocks?: unknown[];
  attachments?: SlackMessageAttachment[];
}

interface SlackMessageBlock {
  message?: SlackMessageContent;
}

interface SlackMessageAttachment extends SlackMessageContent {
  fallback?: string;
  pretext?: string;
  title?: string;
  fields?: Array<{ title?: string; value?: string }>;
  author_name?: string;
  author_subname?: string;
  author_id?: string;
  channel_name?: string;
  channel_id?: string;
  is_msg_unfurl?: boolean;
  is_share?: boolean;
  ts?: string | number;
  message_blocks?: SlackMessageBlock[];
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : []);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function textObject(value: unknown): string {
  if (typeof value === "string") return value;
  return isNode(value) ? str(value.text) : "";
}

function richTextLeaf(element: Node): string {
  switch (element.type) {
    case "text":
      return str(element.text);
    case "link":
      return str(element.text) || str(element.url);
    case "user":
      return `<@${str(element.user_id)}>`;
    case "usergroup":
      return `<!subteam^${str(element.usergroup_id)}>`;
    case "channel":
      return `<#${str(element.channel_id)}>`;
    case "broadcast":
      return `<!${str(element.range)}>`;
    case "emoji":
      return `:${str(element.name)}:`;
    case "date":
      return str(element.fallback);
    default:
      return nodes(element.elements).map(richTextLeaf).join("");
  }
}

function richText(element: Node): string {
  if (element.type === "rich_text_list") return nodes(element.elements).map(richText).join("\n");
  return nodes(element.elements).map(richTextLeaf).join("");
}

function blockText(block: Node): string {
  switch (block.type) {
    case "rich_text":
      return nodes(block.elements).map(richText).join("\n");
    case "section":
      return [textObject(block.text), ...nodes(block.fields).map(textObject)].filter(Boolean).join("\n");
    case "context":
      return nodes(block.elements).map(textObject).filter(Boolean).join(" ");
    case "header":
    case "markdown":
      return textObject(block.text);
    default:
      return "";
  }
}

const blocksText = (blocks: unknown): string[] =>
  nodes(blocks)
    .map((block) => blockText(block).trim())
    .filter(Boolean);

function attachmentText(attachment: SlackMessageAttachment): string {
  const parts = [
    str(attachment.pretext),
    str(attachment.title),
    str(attachment.text),
    ...nodes(attachment.fields).map((field) => [str(field.title), str(field.value)].filter(Boolean).join(": ")),
    ...blocksText(attachment.blocks),
  ]
    .map((part) => part.trim())
    .filter(Boolean);
  return (parts.length ? parts : [str(attachment.fallback).trim()]).filter(Boolean).join("\n");
}

function isForwardedAttachment(attachment: SlackMessageAttachment): boolean {
  return attachment.is_msg_unfurl === true || attachment.is_share === true;
}

function nestedMessages(attachment: SlackMessageAttachment): SlackMessageContent[] {
  const messages = (attachment.message_blocks ?? []).flatMap((block) =>
    block?.message && typeof block.message === "object" ? [block.message] : [],
  );
  return attachment.attachments?.length ? [...messages, { attachments: attachment.attachments }] : messages;
}

export function slackMessageContent(message: SlackMessageContent): { text: string; files: SlackFile[] } {
  const rendered: string[] = [];
  const files: SlackFile[] = [];
  const seenFiles = new Set<string>();
  let renderedForwards = 0;

  const addFile = (file: SlackFile, authorId?: string): void => {
    if (!file || typeof file !== "object") return;
    if (file.id && seenFiles.has(file.id)) return;
    if (file.id) seenFiles.add(file.id);
    files.push(file.user || !authorId ? file : { ...file, user: authorId });
  };

  const visit = (current: SlackMessageContent, depth: number): void => {
    if (depth > MAX_FORWARD_DEPTH) return;
    for (const attachment of Array.isArray(current.attachments) ? current.attachments : []) {
      if (!attachment || typeof attachment !== "object") continue;
      if (!isForwardedAttachment(attachment)) {
        const text = attachmentText(attachment);
        if (text) rendered.push(text);
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

  const base = String(message.text ?? "") || blocksText(message.blocks).join("\n");
  let text = base;
  if (rendered.length) text = base ? `${base}\n${rendered.join("\n")}` : rendered.join("\n");
  return { text, files };
}
