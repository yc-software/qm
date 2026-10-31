import { safeCutIndex as cutIndex, splitFenced, type ProtectedSpan } from "../surfaces/chunking.ts";

const ENTITY: ProtectedSpan = { open: "<", close: ">" };

export const safeCutIndex = (text: string, max: number): number => cutIndex(text, max, ENTITY);

export function safeChunks(text: string, max: number): string[] {
  return splitFenced(text, max, { cutAt: safeCutIndex });
}

/** Truncate to at most `max` characters (plus ellipsis) at a safe point. */
export function safeClip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, safeCutIndex(text, max))}…`;
}
