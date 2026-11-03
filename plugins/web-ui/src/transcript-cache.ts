import { LRUCache } from "lru-cache";
import type { TranscriptPage } from "./core-bridge";

const cache = new LRUCache<string, TranscriptPage>({ max: 40 });

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
  return (page.earlierItems ?? 0) > 0 ? (page.items[0]?.seq ?? null) : null;
}

export function transcriptChanged(cached: TranscriptPage, fresh: TranscriptPage): boolean {
  const seen = new Set(cached.items.map((item) => item.seq));
  if (fresh.items.some((item) => !seen.has(item.seq))) return true;
  const extras = (page: TranscriptPage) => JSON.stringify([page.pins ?? [], page.goal ?? null, page.runtime ?? null]);
  return extras(cached) !== extras(fresh);
}
