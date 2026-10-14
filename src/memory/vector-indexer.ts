import { unitVector, type MemoryEmbedder } from "../model/embeddings.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { reportFailure } from "../util/errors.ts";
import type { MemoryVectorStore } from "./postgres-vector-store.ts";

export function createMemoryVectorIndexer(opts: {
  resolve: () => Promise<
    { embedder: MemoryEmbedder; store: Pick<MemoryVectorStore, "missing" | "put" | "prune"> } | undefined
  >;
  leaderLease: LeaderLease;
  onError?: (error: unknown) => void;
  now?: () => number;
}) {
  const onError = opts.onError ?? ((error: unknown) => reportFailure("memory vector index", error));
  let pending: Promise<void> | undefined;
  let model: string | undefined;
  let dimensions: number | undefined;
  let afterId: string | undefined;
  let nextProbeAt = 0;
  async function run(): Promise<void> {
    await opts.leaderLease.hold("memory:vector-index", async (lost) => {
      const current = await opts.resolve();
      if (!current) return;
      const controller = new AbortController();
      void lost.then(() => controller.abort());
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
      const { embedder, store } = current;
      const now = (opts.now ?? Date.now)();
      if (model !== embedder.id || dimensions === undefined || now >= nextProbeAt) {
        const probe = await embedder.embed(["Memory index dimension probe."], signal);
        if (probe.length !== 1) throw new Error("Invalid memory index dimension probe");
        const width = unitVector(probe[0]).length;
        if (width > 16000) throw new Error("Memory embedding exceeds pgvector dimensions");
        if (model !== embedder.id || dimensions !== width) afterId = undefined;
        model = embedder.id;
        dimensions = width;
        nextProbeAt = now + 10 * 60_000;
      }
      signal.throwIfAborted();
      const facts = await store.missing(embedder.id, 64, dimensions, signal, afterId);
      afterId = facts.at(-1)?.factId;
      try {
        if (facts.length) {
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
          if (rows.some((row) => row.vector.length !== dimensions)) {
            dimensions = undefined;
            nextProbeAt = 0;
            afterId = undefined;
            throw new Error("Memory embedding dimensions changed during indexing");
          }
          signal.throwIfAborted();
          await store.put(rows, signal);
        }
      } finally {
        if (!signal.aborted) await store.prune(embedder.id, 200, dimensions, signal).catch(onError);
      }
    });
  }
  return {
    tick(): Promise<void> {
      pending ??= run()
        .catch(onError)
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
