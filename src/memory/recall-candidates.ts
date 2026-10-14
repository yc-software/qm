import type { MemoryCandidate } from "./facts.ts";
import type { MemoryRecallContext, MemoryService } from "./memory-service.ts";

export class MemoryRecallRetry extends Error {
  constructor(cause: unknown) {
    super("Semantic memory recall failed; retry with recency", { cause });
  }
}

export const compareCandidates = (a: MemoryCandidate, b: MemoryCandidate): number =>
  b.score - a.score || (b.at ?? 0) - (a.at ?? 0);

export async function* recallCandidates(
  memory: MemoryService,
  scope: string,
  context?: MemoryRecallContext,
): AsyncGenerator<MemoryCandidate> {
  if (memory.recallPages) {
    for await (const page of memory.recallPages(scope, context)) yield* page;
  } else {
    yield* (await memory.recall(scope, context)).sort(compareCandidates);
  }
}

export async function* mergeCandidates<T extends MemoryCandidate>(
  sources: readonly AsyncIterable<T>[],
): AsyncGenerator<T> {
  const iterators = sources.map((source) => source[Symbol.asyncIterator]());
  try {
    const heads = await Promise.all(iterators.map((iterator) => iterator.next()));
    for (;;) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i]!;
        if (!head.done && (best === -1 || compareCandidates(head.value, heads[best]!.value) < 0)) best = i;
      }
      if (best === -1) return;
      yield heads[best]!.value;
      heads[best] = await iterators[best]!.next();
    }
  } finally {
    await Promise.all(iterators.map((iterator) => iterator.return?.()));
  }
}
