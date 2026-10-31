import { safeCutIndex, splitFenced } from "../surfaces/chunking.ts";

export const DISCORD_MESSAGE_LIMIT = 2000;
const SEPARATORS = ["\n\n", "\n", " "];

function cutAtSeparator(text: string, max: number): number {
  if (text.length <= max) return text.length;
  const window = text.slice(0, max);
  for (const sep of SEPARATORS) {
    const i = window.lastIndexOf(sep);
    if (i > max / 2) return i + sep.length;
  }
  return safeCutIndex(text, max);
}

export function chunkMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  return splitFenced(text.trim(), limit, { cutAt: cutAtSeparator, keepFenceInfo: true })
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}
