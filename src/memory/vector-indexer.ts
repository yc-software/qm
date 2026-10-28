import { unitVector, type MemoryEmbedder } from "../model/embeddings.ts";
import { reportFailure } from "../util/errors.ts";
import type { MemoryVectorStore } from "./postgres-vector-store.ts";
import { perTenant } from "../tenant.ts";

export function createMemoryVectorIndexer(opts: {
  resolve: () => Promise<
    { embedder: MemoryEmbedder; store: Pick<MemoryVectorStore, "missing" | "put" | "prune"> } | undefined
  >;
  onError?: (error: unknown) => void;
  now?: () => number;
}) {
  const onError = opts.onError ?? ((error: unknown) => reportFailure("memory vector index", error));
  const state = perTenant(() => ({
    pending: undefined as Promise<void> | undefined,
    active: undefined as AbortController | undefined,
    model: undefined as string | undefined,
    dimensions: undefined as number | undefined,
    afterId: undefined as string | undefined,
    nextProbeAt: 0,
  }));
  async function run(): Promise<void> {
    const s = state();
    const controller = (s.active = new AbortController());
    const current = await opts.resolve();
    if (!current) return;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    signal.throwIfAborted();
    const { embedder, store } = current;
    const now = (opts.now ?? Date.now)();
    if (s.model !== embedder.id || s.dimensions === undefined || now >= s.nextProbeAt) {
      const probe = await embedder.embed(["Memory index dimension probe."], signal);
      if (probe.length !== 1) throw new Error("Invalid memory index dimension probe");
      const width = unitVector(probe[0]).length;
      if (width > 16000) throw new Error("Memory embedding exceeds pgvector dimensions");
      if (s.model !== embedder.id || s.dimensions !== width) s.afterId = undefined;
      s.model = embedder.id;
      s.dimensions = width;
      s.nextProbeAt = now + 10 * 60_000;
    }
    try {
      do {
        signal.throwIfAborted();
        const facts = await store.missing(embedder.id, 64, s.dimensions, signal, s.afterId);
        s.afterId = facts.at(-1)?.factId;
        if (!facts.length) break;
        const vectors = await embedder.embed(
          facts.map((fact) => fact.text.slice(0, 8000)),
          signal,
        );
        if (vectors.length !== facts.length) throw new Error("Invalid memory index embedding count");
        const rows = facts.map((fact, i) => ({
          scope: fact.scope,
          factId: fact.factId,
          hash: fact.hash,
          model: embedder.id,
          vector: unitVector(vectors[i]),
        }));
        if (rows.some((row) => row.vector.length !== s.dimensions)) {
          s.dimensions = undefined;
          s.nextProbeAt = 0;
          s.afterId = undefined;
          throw new Error("Memory embedding dimensions changed during indexing");
        }
        signal.throwIfAborted();
        await store.put(rows, signal);
        if (facts.length < 64) break;
      } while ((opts.now ?? Date.now)() - now < 20_000);
    } finally {
      if (!signal.aborted) await store.prune(embedder.id, 200, s.dimensions, signal).catch(onError);
    }
  }
  const indexing = new Set<ReturnType<typeof state>>();
  return {
    async stop(): Promise<void> {
      for (const s of indexing) s.active?.abort();
      await Promise.all([...indexing].map((s) => s.pending));
    },
    tick(): Promise<void> {
      const s = state();
      indexing.add(s);
      s.pending ??= run()
        .catch(onError)
        .finally(() => {
          s.pending = undefined;
          s.active = undefined;
          indexing.delete(s);
        });
      return s.pending;
    },
  };
}
