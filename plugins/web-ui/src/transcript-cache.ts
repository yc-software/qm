import { LRUCache } from "lru-cache";
import { swallow } from "../../chassis/src/errors";
import { fetchTranscript, TAIL_TURNS, type TranscriptPage } from "./core-bridge";

const cache = new LRUCache<string, TranscriptPage>({ max: 40 });
const pendingRefreshes = new Map<string, ReturnType<typeof setTimeout>>();

const CACHE_REFRESH_DEBOUNCE_MS = 1_000;

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
  for (const timer of pendingRefreshes.values()) clearTimeout(timer);
  pendingRefreshes.clear();
  cache.clear();
}

export function resyncTranscriptCache(openIds: readonly string[]): void {
  clearTranscriptCache();
  for (const id of openIds)
    fetchTranscript(id, { tailTurns: TAIL_TURNS }).then(
      (page) => storeTranscript(id, page),
      (error: unknown) => swallow("web-ui: resync cached transcript", error),
    );
}

export function refreshCachedTranscript(id: string): void {
  if (!cache.has(id) || pendingRefreshes.has(id)) return;
  pendingRefreshes.set(
    id,
    setTimeout(() => {
      pendingRefreshes.delete(id);
      if (!cache.has(id)) return;
      fetchTranscript(id, { tailTurns: TAIL_TURNS }).then(
        (page) => {
          if (cache.has(id)) cache.set(id, page);
        },
        (error: unknown) => {
          cache.delete(id);
          swallow("web-ui: refresh cached transcript", error);
        },
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
