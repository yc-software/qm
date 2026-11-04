import { unitVector, type MemoryEmbedder } from "../model/embeddings.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { reportFailure } from "../util/errors.ts";
import { boundTenant, withoutTenant } from "../tenants/context.ts";
import type { MemoryVectorStore } from "./postgres-vector-store.ts";

interface IndexState {
  model?: string;
  dimensions?: number;
  afterId?: string;
  nextProbeAt: number;
}

type IndexTarget = { embedder: MemoryEmbedder; store: Pick<MemoryVectorStore, "missing" | "put" | "prune"> };

async function probeWidth(embedder: MemoryEmbedder, signal: AbortSignal): Promise<number> {
  const probe = await embedder.embed(["Memory index dimension probe."], signal);
  if (probe.length !== 1) throw new Error("Invalid memory index dimension probe");
  const width = unitVector(probe[0]).length;
  if (width > 16000) throw new Error("Memory embedding exceeds pgvector dimensions");
  return width;
}

async function indexBatches(target: IndexTarget, state: IndexState, signal: AbortSignal, now: () => number) {
  const { embedder, store } = target;
  const startedAt = now();
  do {
    signal.throwIfAborted();
    const facts = await store.missing(embedder.id, 64, state.dimensions, signal, state.afterId);
    state.afterId = facts.at(-1)?.factId;
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
    if (rows.some((row) => row.vector.length !== state.dimensions)) {
      state.dimensions = undefined;
      state.nextProbeAt = 0;
      state.afterId = undefined;
      throw new Error("Memory embedding dimensions changed during indexing");
    }
    signal.throwIfAborted();
    await store.put(rows, signal);
    if (facts.length < 64) break;
  } while (now() - startedAt < 20_000);
}

export function createMemoryVectorIndexer(opts: {
  resolve: () => Promise<IndexTarget | undefined>;
  eachTenant?: (fn: () => Promise<unknown>) => Promise<void>;
  leaderLease: LeaderLease;
  onError?: (error: unknown) => void;
  now?: () => number;
}) {
  const onError = opts.onError ?? ((error: unknown) => reportFailure("memory vector index", error));
  const now = opts.now ?? Date.now;
  const eachTenant = opts.eachTenant ?? ((fn: () => Promise<unknown>) => fn().then(() => undefined));
  const states = new Map<string, IndexState>();
  let pending: Promise<void> | undefined;
  let active: AbortController | undefined;
  async function indexTenant(controller: AbortController, lost: Promise<unknown>): Promise<void> {
    const current = await opts.resolve();
    if (!current) return;
    void lost.then(() => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    signal.throwIfAborted();
    const key = boundTenant() ?? "";
    const state = states.get(key) ?? { nextProbeAt: 0 };
    states.set(key, state);
    const { embedder, store } = current;
    const at = now();
    if (state.model !== embedder.id || state.dimensions === undefined || at >= state.nextProbeAt) {
      const width = await probeWidth(embedder, signal);
      if (state.model !== embedder.id || state.dimensions !== width) state.afterId = undefined;
      state.model = embedder.id;
      state.dimensions = width;
      state.nextProbeAt = at + 10 * 60_000;
    }
    try {
      await indexBatches(current, state, signal, now);
    } finally {
      if (!signal.aborted) await store.prune(embedder.id, 200, state.dimensions, signal).catch(onError);
    }
  }
  async function run(): Promise<void> {
    const controller = (active = new AbortController());
    await opts.leaderLease.hold("memory:vector-index", (lost) =>
      eachTenant(() => (controller.signal.aborted ? Promise.resolve() : indexTenant(controller, lost).catch(onError))),
    );
  }
  return {
    stop(): Promise<void> {
      active?.abort();
      return pending ?? Promise.resolve();
    },
    tick(): Promise<void> {
      pending ??= withoutTenant(run)
        .catch(onError)
        .finally(() => {
          pending = undefined;
          active = undefined;
        });
      return pending;
    },
  };
}
