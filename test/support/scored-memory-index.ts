import type { MemoryService } from "../../src/memory/memory-service.ts";
import type { MemoryVectorStore } from "../../src/memory/postgres-vector-store.ts";
import { factHash } from "../../src/memory/facts.ts";

export function scoredMemoryIndex(
  base: MemoryService,
  score: (text: string) => number,
  pageSize = 16,
): Pick<MemoryVectorStore, "search"> {
  return {
    async *search(input) {
      const facts = await base.facts!(input.scope);
      const rows = facts
        .flatMap((fact) => {
          const hash = factHash(fact.text);
          const similarity = score(fact.text);
          if (
            !input.facts.some((wanted) => wanted.id === fact.id && wanted.hash === hash) ||
            similarity < (input.minSimilarity ?? 0.2)
          )
            return [];
          return [{ factId: fact.id, hash, score: similarity, at: fact.createdAt }];
        })
        .sort((a, b) => b.score - a.score || b.at - a.at);
      for (let i = 0; i < rows.length; i += pageSize) yield rows.slice(i, i + pageSize);
    },
  };
}
