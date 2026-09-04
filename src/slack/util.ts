import { safeCutIndex, safeClip } from "./safe-cut.ts";

export function inlineCode(text: string): string {
  const cleaned = text.replace(/`/g, "'");
  const safe = cleaned.slice(0, safeCutIndex(cleaned, 2000));
  return `\`${safe}${cleaned.length > safe.length ? "..." : ""}\``;
}

export function clip(text: string, max: number): string {
  return safeClip(text, max);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
