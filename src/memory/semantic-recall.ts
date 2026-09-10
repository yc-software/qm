import { createHash } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { SessionEntry } from "../types.ts";
import { createKeyedQueue } from "../util/async.ts";
import type { MemoryService, MemoryRecallContext, MemoryCandidate } from "./memory-service.ts";
import { bullets, RECALL_MAX_CHARS } from "./notebook.ts";
import { unitVector, type MemoryEmbedder } from "./embeddings.ts";

export interface MemoryVectorIndex {
  model: string;
  vectors: Record<string, number[]>;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

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

function pack(facts: readonly string[], maxChars: number): string {
  const lines: string[] = [];
  let remaining = maxChars;
  for (const fact of facts) {
    const line = `- ${fact}`;
    const size = line.length + (lines.length ? 1 : 0);
    if (size > remaining) continue;
    lines.push(line);
    remaining -= size;
  }
  return lines.join("\n");
}

/** The notebook remains authoritative; vectors are only a rebuildable, scope-local cache. */
export function createSemanticMemoryService(
  base: MemoryService,
  embedder: MemoryEmbedder,
  index: Pick<DurableMap<MemoryVectorIndex>, "get" | "put" | "delete">,
  opts: { minSimilarity?: number; onError?: () => void } = {},
): MemoryService {
  const queue = createKeyedQueue<string>();
  async function indexed(scope: string, signal: AbortSignal) {
    return queue(scope, async () => {
      signal.throwIfAborted();
      const facts = [...new Set(bullets(await base.read(scope)))];
      if (!facts.length) {
        await index.delete(scope);
        return { facts, vectors: {} as Record<string, number[]> };
      }
      const saved = await index.get(scope);
      const cached = saved?.model === embedder.id ? saved.vectors : {};
      const vectors: Record<string, number[]> = {};
      const missing: string[] = [];
      for (const fact of facts) {
        const key = hash(fact);
        if (cached[key]) vectors[key] = unitVector(cached[key]);
        else missing.push(fact);
      }
      // Prune removed facts even if the embedding service is unavailable.
      if (Object.keys(cached).length !== Object.keys(vectors).length || saved?.model !== embedder.id) {
        await index.put(scope, { model: embedder.id, vectors: { ...vectors } });
      }
      for (let start = 0; start < missing.length; start += 64) {
        const batch = missing.slice(start, start + 64);
        const embedded = await embedder.embed(
          batch.map((f) => f.replace(/^\(\d{4}-\d\d-\d\d\)\s*/, "").slice(0, 8000)),
          signal,
        );
        if (embedded.length !== batch.length) throw new Error("Missing memory embeddings");
        batch.forEach((fact, i) => {
          vectors[hash(fact)] = unitVector(embedded[i]);
        });
        // Checkpoint backfills so a timeout does not restart a large notebook from zero.
        const current = new Set(bullets(await base.read(scope)).map(hash));
        for (const key of Object.keys(vectors)) if (!current.has(key)) delete vectors[key];
        await index.put(scope, { model: embedder.id, vectors: { ...vectors } });
      }
      return { facts: facts.filter((f) => vectors[hash(f)]), vectors };
    });
  }
  const queries = new WeakMap<MemoryRecallContext, Promise<number[]>>();
  async function candidates(scope: string, context?: MemoryRecallContext): Promise<MemoryCandidate[]> {
    const query = context?.query?.trim();
    const recent = async () =>
      bullets(await base.read(scope))
        .reverse()
        .map((f) => ({ text: `- ${f}`, score: 0.2 }));
    if (!query || !context) return recent();
    try {
      const signal = AbortSignal.timeout(8000);
      const { facts, vectors } = await indexed(scope, signal);
      if (!facts.length) return [];
      let request = queries.get(context);
      if (!request) {
        const input = context.recentContext
          ? `${context.recentContext.slice(-2000)}\nCurrent message: ${query.slice(0, 2000)}`
          : query.slice(0, 4000);
        request = embedder.embed([input], signal).then((result) => unitVector(result[0]));
        queries.set(context, request);
      }
      const queryVector = await request;
      const ranked = facts
        .map((fact) => {
          const vector = vectors[hash(fact)]!;
          if (vector.length !== queryVector.length)
            throw new Error("Memory embedding dimensions changed; configure the new model ID");
          const score = vector.reduce((sum, value, i) => sum + value * queryVector[i]!, 0);
          return { fact, score };
        })
        .filter((row) => row.score >= (opts.minSimilarity ?? 0.2))
        .sort((a, b) => b.score - a.score);
      const current = new Set(bullets(await base.read(scope)));
      return ranked.filter((row) => current.has(row.fact)).map((row) => ({ text: `- ${row.fact}`, score: row.score }));
    } catch {
      opts.onError?.();
      return recent();
    }
  }
  return {
    ...base,
    recallCandidates: candidates,
    async recall(scope, context) {
      const budget = Math.max(0, Math.min(RECALL_MAX_CHARS, Math.floor(context?.maxChars ?? RECALL_MAX_CHARS)));
      if (!budget) return "";
      return pack(
        (await candidates(scope, context)).map((row) => row.text.slice(2)),
        budget,
      );
    },
  };
}
