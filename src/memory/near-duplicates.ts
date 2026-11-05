import { unitVector, type MemoryEmbedder } from "../model/embeddings.ts";
import { factHash } from "./facts.ts";
import type { FindNearDuplicates, NearDuplicate } from "./memory-service.ts";
import type { MemoryVectorStore } from "./postgres-vector-store.ts";

export const NEAR_DUPLICATE_SIMILARITY = 0.9;

const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, i) => sum + value * b[i]!, 0);

export function nearDuplicateMatches(
  vectors: readonly number[][],
  stored: readonly (string | undefined)[],
): (NearDuplicate | undefined)[] {
  return vectors.map((vector, line) => {
    const factId = stored[line];
    if (factId) return { factId };
    const earlier = vectors.findIndex((other, i) => i < line && cosine(vector, other) >= NEAR_DUPLICATE_SIMILARITY);
    return earlier < 0 ? undefined : { line: earlier };
  });
}

export function createNearDuplicateFinder(
  resolve: () => Promise<{ embedder: MemoryEmbedder; store: MemoryVectorStore } | undefined>,
  onError: (error: unknown) => void,
): FindNearDuplicates {
  return async (scope, texts) => {
    try {
      const current = await resolve();
      if (!current) return undefined;
      const { embedder, store } = current;
      const embedded = await embedder.embed(
        texts.map((text) => text.slice(0, 8000)),
        AbortSignal.timeout(8000),
      );
      if (embedded.length !== texts.length) throw new Error("Invalid memory embedding count");
      const vectors = embedded.map(unitVector);
      const model = embedder.id;
      const stored = await store.nearest({ scope, model, vectors, minSimilarity: NEAR_DUPLICATE_SIMILARITY });
      return {
        matches: nearDuplicateMatches(vectors, stored),
        index: (written) =>
          store
            .put(
              written.map(({ id, line }) => ({
                scope,
                model,
                factId: id,
                hash: factHash(texts[line]!),
                vector: vectors[line]!,
              })),
            )
            .catch(onError),
      };
    } catch (error) {
      onError(error);
      return undefined;
    }
  };
}
