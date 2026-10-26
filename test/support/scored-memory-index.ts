import type { MemoryService } from "../../src/memory/memory-service.ts";
import type { MemoryVectorStore } from "../../src/memory/postgres-vector-store.ts";

export function scoredMemoryIndex(
  base: MemoryService,
  score: (text: string) => number,
): Pick<MemoryVectorStore, "search"> {
  return {
    async search(input) {
      const facts = await base.facts!(input.scope);
      const rows = facts
        .flatMap((fact) => {
          const similarity = score(fact.text);
          if (!input.ids.includes(fact.id) || similarity < (input.minSimilarity ?? 0.2)) return [];
          return [{ factId: fact.id, updatedAt: fact.updatedAt, score: similarity, at: fact.createdAt }];
        })
        .sort((a, b) => b.score - a.score || b.at - a.at);
      return rows;
    },
  };
}
