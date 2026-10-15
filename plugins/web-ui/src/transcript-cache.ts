import { LRUCache } from "lru-cache";
import type { TranscriptPage } from "./core-bridge";

export const TRANSCRIPT_CACHE_MAX = 40;

const cache = new LRUCache<string, TranscriptPage>({ max: TRANSCRIPT_CACHE_MAX });

export function cachedTranscript(id: string): TranscriptPage | undefined {
  return cache.get(id);
}

export function storeTranscript(id: string, page: TranscriptPage): void {
  cache.set(id, page);
}

export function dropTranscript(id: string): void {
  cache.delete(id);
}

export function clearTranscriptCache(): void {
  cache.clear();
}

export function pageAnchor(page: TranscriptPage): number | null {
  return (page.earlierEntries ?? 0) > 0 ? (page.entries?.[0]?.seq ?? null) : null;
}

export function lastSeq(page: TranscriptPage): number {
  let last = -1;
  for (const entry of page.entries ?? []) if (entry.seq !== undefined && entry.seq > last) last = entry.seq;
  return last;
}

export function mergeTranscriptDelta(page: TranscriptPage, delta: TranscriptPage): TranscriptPage {
  const after = lastSeq(page);
  const added = (delta.entries ?? []).filter((entry) => entry.seq !== undefined && entry.seq > after);
  const samePins = JSON.stringify(page.pins ?? []) === JSON.stringify(delta.pins ?? []);
  if (!added.length && samePins) return page;
  return { ...page, entries: [...(page.entries ?? []), ...added], pins: delta.pins };
}
