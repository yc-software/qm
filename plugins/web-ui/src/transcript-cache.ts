import { LRUCache } from "lru-cache";
import { fetchTranscript, TAIL_TURNS, type TranscriptPage } from "./core-bridge";

type TranscriptWindow = Parameters<typeof fetchTranscript>[1];

const PREFETCH_LIMIT = 2;
const pages = new LRUCache<string, TranscriptPage>({
  max: 20,
  maxSize: 40_000,
  sizeCalculation: (page) => Math.max(1, page.entries.length),
});
const generations = new Map<string, number>();
const inflight = new Map<string, Promise<TranscriptPage>>();
let prefetching = 0;

export function cachedTranscript(id: string): TranscriptPage | undefined {
  return pages.get(id);
}

export function forgetTranscript(id: string): void {
  pages.delete(id);
  generations.set(id, (generations.get(id) ?? 0) + 1);
}

function resumeSeq(entries: TranscriptPage["entries"]): number | undefined {
  if (!entries.length || entries.some((e) => e.seq === undefined)) return undefined;
  return entries.findLast((e) => e.type === "user")?.seq ?? entries[0]!.seq;
}

function extendsCache(cached: TranscriptPage | undefined, window: TranscriptWindow): boolean {
  if (!cached || window?.sinceSeq === undefined || window.beforeSeq !== undefined || window.tailTurns !== undefined)
    return false;
  return window.sinceSeq === cached.entries[0]?.seq || (window.sinceSeq === 0 && !cached.earlierEntries);
}

export function loadTranscript(
  id: string,
  window?: TranscriptWindow,
  fetcher: typeof fetchTranscript = fetchTranscript,
): Promise<TranscriptPage> {
  const cached = pages.peek(id);
  const extend = extendsCache(cached, window);
  const tail = window?.tailTurns === TAIL_TURNS && window.sinceSeq === undefined && window.beforeSeq === undefined;
  if (!tail && !extend) return fetcher(id, window);
  const pending = inflight.get(id);
  if (pending) return extend ? pending.catch(() => undefined).then(() => loadTranscript(id, window, fetcher)) : pending;
  const from = cached ? resumeSeq(cached.entries) : undefined;
  const generation = generations.get(id);
  const read = (
    cached && from !== undefined
      ? fetcher(id, { sinceSeq: from }).then((delta) =>
          delta.entries[0]?.seq === from
            ? {
                ...delta,
                entries: [...cached.entries.filter((e) => e.seq! < from), ...delta.entries],
                earlierEntries: cached.earlierEntries,
              }
            : delta,
        )
      : fetcher(id, { tailTurns: TAIL_TURNS })
  )
    .then((page) => {
      if (generations.get(id) === generation) pages.set(id, page);
      return page;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, read);
  return read;
}

export function prefetchTranscript(id: string | undefined): void {
  if (!id || pages.has(id) || inflight.has(id) || prefetching >= PREFETCH_LIMIT) return;
  prefetching++;
  void loadTranscript(id, { tailTurns: TAIL_TURNS })
    .catch(() => undefined)
    .finally(() => prefetching--);
}
