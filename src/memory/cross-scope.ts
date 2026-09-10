import type { ScopeId } from "../types.ts";
import type { MemoryService, MemoryRecallContext, MemoryCandidate } from "./memory-service.ts";
import { RECALL_MAX_CHARS } from "./notebook.ts";

export function recallCandidates(
  memory: MemoryService,
  scope: ScopeId,
  context?: MemoryRecallContext,
): Promise<MemoryCandidate[]> {
  if (memory.recallCandidates) return memory.recallCandidates(scope, context);
  return memory.recall(scope, context).then((body) =>
    body
      .split("\n")
      .filter((line) => line.trim())
      .map((text) => ({ text, score: 0.2 })),
  );
}

/** Callers supply the authorized scope list; retrieval must never discover extra scopes. */
export async function recallAcrossScopes(
  memory: MemoryService,
  scopes: readonly ScopeId[],
  context: MemoryRecallContext,
): Promise<string> {
  const budget = Math.max(0, Math.min(RECALL_MAX_CHARS, Math.floor(context.maxChars ?? RECALL_MAX_CHARS)));
  if (!budget) return "";
  const unique = [...new Set(scopes)];
  const batches = await Promise.all(
    unique.map(async (scope) =>
      (await recallCandidates(memory, scope, context)).map((row) => ({
        ...row,
        scope,
        rank: row.score + (scope === context.conversationScopeId ? 0.04 : 0),
      })),
    ),
  );
  const ranked = batches.flat().sort((a, b) => b.rank - a.rank);
  const seen = new Set<string>();
  let out = "",
    previous: ScopeId | undefined;
  for (const row of ranked) {
    if (!row.text.trim() || seen.has(row.text)) continue;
    const header = unique.length > 1 && previous !== row.scope ? `### ${row.scope}\n` : "";
    const addition = `${out ? "\n\n" : ""}${header}${row.text}`;
    if (out.length + addition.length > budget) continue;
    out += addition;
    previous = row.scope;
    seen.add(row.text);
  }
  return out;
}

/** Round-robin prevents a busy notebook from consuming the entire grep result page. */
export async function searchAcrossScopes(
  memory: MemoryService,
  scopes: readonly ScopeId[],
  query: string,
  limit = 20,
  context?: MemoryRecallContext,
): Promise<Array<{ scopeId: ScopeId; fact: string }>> {
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20;
  const unique = [...new Set(scopes)];
  const batches = await Promise.all(unique.map((scope) => memory.query(scope, query, count, context)));
  const out: Array<{ scopeId: ScopeId; fact: string }> = [];
  for (let i = 0; i < count && out.length < count; i++) {
    for (let j = 0; j < unique.length && out.length < count; j++) {
      const fact = batches[j]![i];
      if (fact !== undefined) out.push({ scopeId: unique[j]!, fact });
    }
  }
  return out;
}
