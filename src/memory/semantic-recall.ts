import type { SessionEntry } from "../types.ts";
import type { MemoryService, MemoryRecallContext } from "./memory-service.ts";
import { factCandidate, factHash, recentCandidates, type MemoryCandidate } from "./facts.ts";
import { unitVector, type MemoryEmbedder } from "../model/embeddings.ts";
import type { MemoryVectorStore } from "./postgres-vector-store.ts";
import { disclosedMemory } from "./disclosure.ts";

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
  index?: Pick<MemoryVectorStore, "search">,
  opts: { minSimilarity?: number; onError?: (error: unknown) => void } = {},
): MemoryService {
  const queries = new WeakMap<MemoryRecallContext, Promise<{ model: string; vector: number[] } | undefined>>();
  function queryFor(context: MemoryRecallContext) {
    let pending = queries.get(context);
    if (!pending) {
      pending = (async () => {
        const signal = AbortSignal.timeout(8000);
        const embedder = await resolveEmbedder();
        if (!embedder) return undefined;
        const vectors = await embedder.embed([context.query!.trim().slice(0, 4000)], signal);
        signal.throwIfAborted();
        return { model: embedder.id, vector: unitVector(vectors[0]) };
      })();
      queries.set(context, pending);
    }
    return pending;
  }
  function view(notebook: MemoryService): MemoryService {
    return {
      ...notebook,
      withDisclosure: (access) => view(disclosedMemory(notebook, access)),
      async recall(scope: string, context: MemoryRecallContext = {}): Promise<MemoryCandidate[]> {
        const facts = (await notebook.facts?.(scope)) ?? [];
        if (!facts.length) return [];
        try {
          const query = index && context.query?.trim() ? await queryFor(context) : undefined;
          if (query && index) {
            const byId = new Map(facts.map((fact) => [fact.id, fact]));
            const matches = await index.search({
              scope,
              ...query,
              facts: facts.map((fact) => ({ id: fact.id, hash: factHash(fact.text), at: fact.createdAt })),
              minSimilarity: opts.minSimilarity,
            });
            return matches.flatMap((match) => {
              const fact = byId.get(match.factId);
              return fact ? [factCandidate(fact, match.score)] : [];
            });
          }
          return recentCandidates(facts);
        } catch (error) {
          opts.onError?.(error);
          return recentCandidates((await notebook.facts?.(scope)) ?? []);
        }
      },
    };
  }
  return view(base);
}
