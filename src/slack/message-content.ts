import type { SlackFile } from "./attachments.ts";

type SlackNode = Record<string, unknown>;

const isNode = (value: unknown): value is SlackNode =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const nodes = (value: unknown): SlackNode[] => (Array.isArray(value) ? value.filter(isNode) : []);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const textObject = (value: unknown): string => (isNode(value) ? str(value.text) : str(value));

function blockText(block: SlackNode): string {
  switch (block.type) {
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

function attachmentText(attachment: SlackNode): string {
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

function forwardLabel(attachment: SlackNode): string {
  const author = str(attachment.author_subname) || str(attachment.author_name) || str(attachment.author_id);
  let channel = "";
  if (str(attachment.channel_name)) channel = `#${str(attachment.channel_name)}`;
  else if (str(attachment.channel_id)) channel = `channel ${str(attachment.channel_id)}`;
  return `forwarded message${author ? ` from ${author}` : ""}${channel ? ` in ${channel}` : ""}`;
}

function nestedMessages(attachment: SlackNode): SlackNode[] {
  const messages = nodes(attachment.message_blocks).flatMap((block) => (isNode(block.message) ? [block.message] : []));
  return nodes(attachment.attachments).length ? [...messages, { attachments: attachment.attachments }] : messages;
}

export function slackMessageContent(message: object): { text: string; files: SlackFile[] } {
  const rendered: string[] = [];
  const files: SlackFile[] = [];
  const seenFiles = new Set<string>();

  const addFile = (file: SlackFile, authorId?: string): void => {
    if (file.id && seenFiles.has(file.id)) return;
    if (file.id) seenFiles.add(file.id);
    files.push(file.user || !authorId ? file : { ...file, user: authorId });
  };

  const visit = (current: SlackNode, nested: boolean): void => {
    for (const attachment of nodes(current.attachments)) {
      if (attachment.is_msg_unfurl !== true && attachment.is_share !== true) {
        const preview = Boolean(attachment.from_url) || attachment.is_app_unfurl === true;
        const text = nested || preview ? "" : attachmentText(attachment);
        if (text) rendered.push(text);
        continue;
      }
      const body = (str(attachment.text) || str(attachment.fallback)).trim();
      rendered.push(body ? `[${forwardLabel(attachment)}] ${body}` : `[${forwardLabel(attachment)}]`);
      for (const file of nodes(attachment.files)) addFile(file, str(attachment.author_id) || undefined);
      for (const inner of nestedMessages(attachment)) visit(inner, true);
    }
  };

  const root = message as SlackNode;
  for (const file of nodes(root.files)) addFile(file);
  visit(root, false);

  const base = String(root.text ?? "") || blocksText(root.blocks).join("\n");
  const text = rendered.length ? [base, ...rendered].filter(Boolean).join("\n") : base;
  return { text, files };
}
