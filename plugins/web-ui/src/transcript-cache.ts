import { LRUCache } from "lru-cache";
import { fetchTranscript, TAIL_TURNS, type TranscriptPage } from "./core-bridge";

const cache = new LRUCache<string, TranscriptPage>({ max: 40 });
const pendingRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
let lastOpened: string | null = null;

const CACHE_REFRESH_DEBOUNCE_MS = 1_000;

export function cachedTranscript(id: string): TranscriptPage | undefined {
  lastOpened = id;
  return cache.get(id);
}

export function storeTranscript(id: string, page: TranscriptPage): void {
  cache.set(id, page);
}

export function dropTranscript(id: string): void {
  cache.delete(id);
}

export function clearTranscriptCache(): void {
  for (const timer of pendingRefreshes.values()) clearTimeout(timer);
  pendingRefreshes.clear();
  cache.clear();
}

export function resyncTranscriptCache(): void {
  const latest = lastOpened;
  clearTranscriptCache();
  if (latest)
    fetchTranscript(latest, { tailTurns: TAIL_TURNS }).then(
      (page) => storeTranscript(latest, page),
      () => {},
    );
}

export function refreshCachedTranscript(id: string): void {
  if (!cache.has(id)) return;
  clearTimeout(pendingRefreshes.get(id));
  pendingRefreshes.set(
    id,
    setTimeout(() => {
      pendingRefreshes.delete(id);
      if (!cache.has(id)) return;
      fetchTranscript(id, { tailTurns: TAIL_TURNS }).then(
        (page) => {
          if (cache.has(id)) cache.set(id, page);
        },
        () => cache.delete(id),
      );
    }, CACHE_REFRESH_DEBOUNCE_MS),
  );
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
