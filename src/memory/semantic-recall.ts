import type { DurableMap } from "../persistence/durable-map.ts";
import type { SessionEntry } from "../types.ts";
import { createKeyedQueue } from "../util/async.ts";
import type { MemoryService, MemoryRecallContext } from "./memory-service.ts";
import { factCandidate, factHash, recentCandidates, type MemoryCandidate, type MemoryFact } from "./facts.ts";
import type { MemoryEmbedder } from "../model/embeddings.ts";

const INDEX_WRITE_LANES = 4;

export interface MemoryVector {
  scope: string;
  model: string;
  hash: string;
  vector: number[];
}

export function memoryRecallQuery(message: string, visibleEntries: readonly SessionEntry[]): string {
  const recent = visibleEntries
    .filter((entry) => entry.type === "user" || entry.type === "assistant")
    .slice(-4)
    .map((entry) => {
      const text = (entry.payload as { text?: unknown } | null)?.text;
      return typeof text === "string" ? `${entry.type}: ${text.slice(-1000)}` : "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(-2000);
  return [recent, message ? `Current message: ${message.slice(0, 2000)}` : ""].filter(Boolean).join("\n");
}

export function createSemanticMemoryService(
  base: MemoryService,
  resolveEmbedder: () => Promise<MemoryEmbedder | undefined>,
  index: Pick<DurableMap<MemoryVector>, "select" | "put" | "delete">,
  opts: { minSimilarity?: number; onError?: (error: unknown) => void } = {},
): MemoryService {
  const queue = createKeyedQueue<string>();
  const writeLanes = createKeyedQueue<number>();
  let nextLane = 0;
  const writeAll = <T>(items: readonly T[], write: (item: T) => Promise<void>): Promise<void[]> =>
    Promise.all(items.map((item) => writeLanes(nextLane++ % INDEX_WRITE_LANES, () => write(item))));
  const vectorId = ({ scope, model, hash }: Omit<MemoryVector, "vector">) => JSON.stringify([scope, model, hash]);
  const cache = new Map<string, number[]>();
  const remember = (model: string, hash: string, vector: number[]) => {
    cache.delete(`${model} ${hash}`);
    cache.set(`${model} ${hash}`, vector);
    if (cache.size > 2_000) cache.delete(cache.keys().next().value!);
  };
  async function indexed(scope: string, facts: readonly MemoryFact[], signal: AbortSignal, embedder: MemoryEmbedder) {
    return queue(scope, async () => {
      signal.throwIfAborted();
      const wanted = new Set(facts.map((fact) => factHash(fact.text)));
      const vectors: Record<string, number[]> = {};
      for (const hash of wanted) {
        const vector = cache.get(`${embedder.id} ${hash}`);
        if (vector) vectors[hash] = vector;
      }
      if (!wanted.size || Object.keys(vectors).length < wanted.size) {
        const stale: MemoryVector[] = [];
        for (const row of await index.select({ where: { field: "scope", anyOfFold: [scope] } })) {
          if (row.scope !== scope) continue;
          if (row.model !== embedder.id || !wanted.has(row.hash)) stale.push(row);
          else {
            vectors[row.hash] = row.vector;
            remember(row.model, row.hash, row.vector);
          }
        }
        await writeAll(stale, (row) => index.delete(vectorId(row)));
      }
      const missing = [...new Set(facts.map((fact) => fact.text))].filter((text) => !vectors[factHash(text)]);
      for (let start = 0; start < missing.length; start += 64) {
        const batch = missing.slice(start, start + 64);
        const embedded = await embedder.embed(
          batch.map((text) => text.slice(0, 8000)),
          signal,
        );
        if (embedded.length !== batch.length) throw new Error("Missing memory embeddings");
        const rows = batch.map((text, i) => ({
          scope,
          model: embedder.id,
          hash: factHash(text),
          vector: embedded[i]!,
        }));
        await writeAll(rows, (row) => index.put(vectorId(row), row));
        for (const row of rows) {
          vectors[row.hash] = row.vector;
          remember(row.model, row.hash, row.vector);
        }
      }
      return vectors;
    });
  }
  const embedders = new WeakMap<MemoryRecallContext, Promise<MemoryEmbedder | undefined>>();
  function embedderFor(context: MemoryRecallContext): Promise<MemoryEmbedder | undefined> {
    let resolving = embedders.get(context);
    if (!resolving) {
      resolving = resolveEmbedder();
      embedders.set(context, resolving);
    }
    return resolving;
  }
  const queries = new WeakMap<MemoryRecallContext, Promise<number[]>>();
  async function recall(scope: string, context: MemoryRecallContext = {}): Promise<MemoryCandidate[]> {
    const facts = (await base.facts?.(scope)) ?? [];
    const query = context.query?.trim();
    try {
      const embedder = await embedderFor(context);
      if (!embedder || !query) return recentCandidates(facts);
      const signal = AbortSignal.timeout(8000);
      const vectors = await indexed(scope, facts, signal, embedder);
      if (!facts.length) return [];
      let request = queries.get(context);
      if (!request) {
        request = embedder.embed([query.slice(0, 4000)], signal).then((result) => result[0]!);
        queries.set(context, request);
      }
      const queryVector = await request;
      if (facts.some((fact) => vectors[factHash(fact.text)]?.length !== queryVector.length)) {
        await writeAll(Object.keys(vectors), (hash) => {
          cache.delete(`${embedder.id} ${hash}`);
          return index.delete(vectorId({ scope, model: embedder.id, hash }));
        });
        throw new Error("Memory embedding dimensions changed; rebuilding the index on the next recall");
      }
      return facts
        .map((fact) => ({
          fact,
          score: vectors[factHash(fact.text)]!.reduce((sum, value, i) => sum + value * queryVector[i]!, 0),
        }))
        .filter(({ score }) => score >= (opts.minSimilarity ?? 0.2))
        .sort((a, b) => b.score - a.score)
        .map(({ fact, score }) => factCandidate(fact, score));
    } catch (error) {
      opts.onError?.(error);
      return recentCandidates(facts);
    }
  }
  return { ...base, recall };
}
