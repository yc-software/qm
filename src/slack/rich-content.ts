import { isObj } from "../util/objects.ts";

const MAX_CHARS = 4_000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const textOf = (v: unknown): string => (isObj(v) ? str(v.text) : "");

function blockText(block: unknown): string[] {
  if (!isObj(block)) return [];
  if (block.type === "header") return [textOf(block.text)];
  if (block.type === "section")
    return [textOf(block.text), ...(Array.isArray(block.fields) ? block.fields : []).map(textOf)];
  if (block.type === "context")
    return [(Array.isArray(block.elements) ? block.elements : []).map(textOf).filter(Boolean).join(" ")];
  if (block.type === "markdown") return [str(block.text)];
  return [];
}

function attachmentText(a: unknown): string[] {
  if (!isObj(a) || a.is_share === true || a.is_msg_unfurl === true) return [];
  const fields = (Array.isArray(a.fields) ? a.fields : []).map((f) =>
    isObj(f) ? [str(f.title), str(f.value)].filter(Boolean).join(": ") : "",
  );
  const parts = [
    str(a.pretext),
    str(a.title),
    str(a.text),
    ...fields,
    ...(Array.isArray(a.blocks) ? a.blocks : []).flatMap(blockText),
  ];
  return parts.some(Boolean) ? parts : [str(a.fallback)];
}

export function withRichContent(message: { text?: unknown; blocks?: unknown; attachments?: unknown }): string {
  const text = typeof message.text === "string" ? message.text : "";
  if (text.trim()) return text;
  const derived = [
    ...(Array.isArray(message.blocks) ? message.blocks : []).flatMap(blockText),
    ...(Array.isArray(message.attachments) ? message.attachments : []).flatMap(attachmentText),
  ]
    .filter(Boolean)
    .join("\n");
  if (!derived) return text;
  return derived.length > MAX_CHARS ? `${derived.slice(0, MAX_CHARS)}…` : derived;
}
