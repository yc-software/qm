import { unitVector, type MemoryEmbedder } from "../model/embeddings.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { reportFailure } from "../util/errors.ts";
import type { MemoryVectorStore } from "./postgres-vector-store.ts";
import { inTenant, type ClaimedRow } from "../tenants/claim.ts";
import { currentTenant } from "../tenants/context.ts";

type IndexStore = Pick<MemoryVectorStore, "missing" | "put" | "prune">;
interface IndexState {
  model?: string;
  dimensions?: number;
  nextProbeAt: number;
  afterId?: string;
}

export function createMemoryVectorIndexer(opts: {
  claim: () => Promise<readonly ClaimedRow[]>;
  resolve: () => Promise<{ embedder: MemoryEmbedder; store: IndexStore } | undefined>;
  leaderLease: LeaderLease;
  onError?: (error: unknown) => void;
  now?: () => number;
}) {
  const onError = opts.onError ?? ((error: unknown) => reportFailure("memory vector index", error));
  const clock = opts.now ?? Date.now;
  let pending: Promise<void> | undefined;
  let active: AbortController | undefined;
  const states = new Map<string, IndexState>();
  let rotation = 0;
  async function index(signal: AbortSignal): Promise<void> {
    const current = await opts.resolve();
    if (!current) return;
    signal.throwIfAborted();
    const { embedder, store } = current;
    const tenant = currentTenant();
    const state = states.get(tenant) ?? { nextProbeAt: 0 };
    states.set(tenant, state);
    const now = clock();
    if (state.model !== embedder.id || state.dimensions === undefined || now >= state.nextProbeAt) {
      const probe = await embedder.embed(["Memory index dimension probe."], signal);
      if (probe.length !== 1) throw new Error("Invalid memory index dimension probe");
      const width = unitVector(probe[0]).length;
      if (width > 16000) throw new Error("Memory embedding exceeds pgvector dimensions");
      if (state.model !== embedder.id || state.dimensions !== width) state.afterId = undefined;
      state.model = embedder.id;
      state.dimensions = width;
      state.nextProbeAt = now + 10 * 60_000;
    }
    try {
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
          Object.assign(state, { dimensions: undefined, nextProbeAt: 0, afterId: undefined });
          throw new Error("Memory embedding dimensions changed during indexing");
        }
        signal.throwIfAborted();
        await store.put(rows, signal);
        if (facts.length < 64) break;
      } while (clock() - now < 20_000);
    } finally {
      if (!signal.aborted) await store.prune(embedder.id, 200, state.dimensions, signal).catch(onError);
    }
  }
  async function run(): Promise<void> {
    const controller = (active = new AbortController());
    await opts.leaderLease.hold("memory:vector-index", async (lost) => {
      void lost.then(() => controller.abort());
      controller.signal.throwIfAborted();
      const claimed = await opts.claim();
      const start = claimed.length ? rotation++ % claimed.length : 0;
      for (const { tenantId } of [...claimed.slice(start), ...claimed.slice(0, start)]) {
        if (controller.signal.aborted) return;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
        await inTenant(tenantId, () => index(signal)).catch((e: unknown) =>
          onError(new Error(`tenant ${tenantId}`, { cause: e })),
        );
      }
    });
  }
  return {
    stop(): Promise<void> {
      active?.abort();
      return pending ?? Promise.resolve();
    },
    tick(): Promise<void> {
      pending ??= run()
        .catch(onError)
        .finally(() => {
          pending = undefined;
          active = undefined;
        });
      return pending;
    },
  };
}
