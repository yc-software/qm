import type { SessionEntry } from "../types.ts";
import type { MemoryService, MemoryRecallContext } from "./memory-service.ts";
import { factCandidate, factHash, recentCandidates, type MemoryCandidate } from "./facts.ts";
import { unitVector, type MemoryEmbedder } from "../model/embeddings.ts";
import type { MemoryVectorStore } from "./postgres-vector-store.ts";
import { disclosedMemory } from "./disclosure.ts";
import { compareCandidates, MemoryRecallRetry } from "./recall-candidates.ts";

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
        const timeout = AbortSignal.timeout(8000);
        const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
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
    async function* recallPages(scope: string, context: MemoryRecallContext = {}): AsyncGenerator<MemoryCandidate[]> {
      const facts = (await notebook.facts?.(scope)) ?? [];
      if (!facts.length) return;
      const emitted = new Set<string>();
      let fallbackFacts = facts;
      try {
        const query = index && !context.recencyOnly && context.query?.trim() ? await queryFor(context) : undefined;
        if (query && index) {
          const byId = new Map(facts.map((fact) => [fact.id, fact]));
          for await (const matches of index.search({
            scope,
            ...query,
            facts: facts.map((fact) => ({ id: fact.id, hash: factHash(fact.text), at: fact.createdAt })),
            minSimilarity: opts.minSimilarity,
            signal: context.signal,
          })) {
            yield matches.flatMap((match) => {
              const fact = byId.get(match.factId);
              if (!fact || factHash(fact.text) !== match.hash || emitted.has(fact.id)) return [];
              emitted.add(fact.id);
              return [factCandidate(fact, match.score)];
            });
          }
          return;
        }
      } catch (error) {
        opts.onError?.(error);
        if (emitted.size) throw new MemoryRecallRetry(error);
        fallbackFacts = (await notebook.facts?.(scope)) ?? [];
      }
      yield recentCandidates(fallbackFacts).sort(compareCandidates);
    }
    return {
      ...notebook,
      withDisclosure: (access) => view(disclosedMemory(notebook, access)),
      recallPages,
      async recall(scope, context) {
        const result: MemoryCandidate[] = [];
        try {
          for await (const page of recallPages(scope, context)) result.push(...page);
          return result;
        } catch (error) {
          if (!(error instanceof MemoryRecallRetry)) throw error;
          const fallback: MemoryCandidate[] = [];
          for await (const page of recallPages(scope, { ...context, recencyOnly: true })) fallback.push(...page);
          return fallback;
        }
      },
    };
  }
  return view(base);
}
