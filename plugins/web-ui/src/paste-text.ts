import { t } from "./i18n.ts";

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(""));
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64ToBytes(content: string): Uint8Array {
  const comma = content.startsWith("data:") ? content.indexOf(",") : -1;
  const binary = atob(comma >= 0 ? content.slice(comma + 1) : content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64ToText(content: string): string {
  return new TextDecoder().decode(base64ToBytes(content));
}

export function pasteChipLabel(charCount: number): string {
  const k = charCount / 1000;
  let count = `${Math.round(k)}k`;
  if (charCount < 1000) count = `${charCount}`;
  else if (k < 9.95) count = `${k.toFixed(1)}k`;
  return t("Pasted text · {count} chars", { count });
}

export function insertIntoDraft(draft: string, text: string, cursor: number | null): { draft: string; cursor: number } {
  const at = cursor === null || cursor < 0 || cursor > draft.length ? draft.length : cursor;
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const trail = after && !after.startsWith("\n") ? "\n" : "";
  const caret = before.length + lead.length + text.length;
  return { draft: before + lead + text + trail + after, cursor: caret };
}
