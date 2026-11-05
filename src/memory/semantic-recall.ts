import { isAgentReply, isUserItem, type Item } from "../sessions/items.ts";
import type { MemoryService, MemoryRecallContext } from "./memory-service.ts";
import { factCandidate, recentCandidates, type MemoryCandidate } from "./facts.ts";
import { unitVector, type MemoryEmbedder } from "../model/embeddings.ts";
import type { MemoryVectorStore } from "./postgres-vector-store.ts";
import { disclosedMemory } from "./disclosure.ts";
import { RECALL_MAX_CHARS } from "./notebook.ts";

const TYPICAL_FACT_CHARS = 120;
const RECALL_LIMIT = Math.ceil((2 * RECALL_MAX_CHARS) / TYPICAL_FACT_CHARS);

export const RECALL_MESSAGE_CHARS = 2000;

export function memoryRecallQuery(message: string, visibleItems: readonly Item[]): string {
  const recent = visibleItems
    .filter((item) => isUserItem(item) || isAgentReply(item))
    .slice(-4)
    .map((item) => `${isUserItem(item) ? "user" : "assistant"}: ${(item.text ?? "").slice(-1000)}`)
    .filter(Boolean)
    .join("\n")
    .slice(-2000);
  return [recent, message ? `Current message: ${message.slice(0, RECALL_MESSAGE_CHARS)}` : ""]
    .filter(Boolean)
    .join("\n");
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
        const pending = index && context.query?.trim() ? queryFor(context) : undefined;
        void pending?.catch(() => undefined);
        const facts = (await context.disclosedFacts)?.get(scope) ?? (await notebook.facts?.(scope)) ?? [];
        if (!facts.length) return [];
        try {
          const query = await pending;
          if (query && index) {
            const byId = new Map(facts.map((fact) => [fact.id, fact]));
            const matches = await index.search({
              scope,
              ...query,
              ids: facts.map((fact) => fact.id),
              limit: RECALL_LIMIT,
              minSimilarity: opts.minSimilarity,
            });
            return matches.flatMap((match) => {
              const fact = byId.get(match.factId);
              return fact?.updatedAt === match.updatedAt ? [factCandidate(fact, match.score)] : [];
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
