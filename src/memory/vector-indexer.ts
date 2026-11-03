import { unitVector, type MemoryEmbedder } from "../model/embeddings.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { reportFailure } from "../util/errors.ts";
import { withoutTenant, withTenant } from "../tenants/context.ts";
import type { MemoryVectorStore } from "./postgres-vector-store.ts";

interface TenantIndex {
  model?: string;
  dimensions?: number;
  afterId?: string;
  nextProbeAt: number;
}

export function createMemoryVectorIndexer(opts: {
  pendingTenants: (signal: AbortSignal) => Promise<string[]>;
  resolve: () => Promise<
    { embedder: MemoryEmbedder; store: Pick<MemoryVectorStore, "missing" | "put" | "prune"> } | undefined
  >;
  leaderLease: LeaderLease;
  onError?: (error: unknown) => void;
  now?: () => number;
}) {
  const onError = opts.onError ?? ((error: unknown) => reportFailure("memory vector index", error));
  const tenants = new Map<string, TenantIndex>();
  let pending: Promise<void> | undefined;
  let active: AbortController | undefined;
  async function index(state: TenantIndex, controller: AbortController): Promise<void> {
    const current = await opts.resolve();
    if (!current) return;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    signal.throwIfAborted();
    const { embedder, store } = current;
    const now = (opts.now ?? Date.now)();
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
    const { dimensions } = state;
    try {
      do {
        signal.throwIfAborted();
        const facts = await store.missing(embedder.id, 64, dimensions, signal, state.afterId);
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
        if (rows.some((row) => row.vector.length !== dimensions)) {
          state.dimensions = undefined;
          state.nextProbeAt = 0;
          state.afterId = undefined;
          throw new Error("Memory embedding dimensions changed during indexing");
        }
        signal.throwIfAborted();
        await store.put(rows, signal);
        if (facts.length < 64) break;
      } while ((opts.now ?? Date.now)() - now < 20_000);
    } finally {
      if (!signal.aborted) await store.prune(embedder.id, 200, state.dimensions, signal).catch(onError);
    }
  }
  async function run(): Promise<void> {
    const controller = (active = new AbortController());
    await opts.leaderLease.hold("memory:vector-index", async (lost) => {
      void lost.then(() => controller.abort());
      for (const tenantId of await opts.pendingTenants(controller.signal)) {
        controller.signal.throwIfAborted();
        const state = tenants.get(tenantId) ?? { nextProbeAt: 0 };
        tenants.set(tenantId, state);
        await withTenant(tenantId, () => index(state, controller)).catch(onError);
      }
    });
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
