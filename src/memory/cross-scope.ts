import type { ScopeId } from "../types.ts";
import type { MemoryService, MemoryRecallContext } from "./memory-service.ts";
import { RECALL_MAX_CHARS } from "./notebook.ts";
import { factLine } from "./facts.ts";

export interface RecalledFact {
  scope: ScopeId;
  id?: string;
  text: string;
}

const heading = (scope: ScopeId, labels: ReadonlyMap<string, string>) => `### ${labels.get(scope) ?? scope}`;

export async function recallAcrossScopes(
  memory: MemoryService,
  scopes: readonly ScopeId[],
  context: MemoryRecallContext,
  labels: ReadonlyMap<string, string> = new Map(),
): Promise<RecalledFact[]> {
  const budget = Math.max(0, Math.min(RECALL_MAX_CHARS, Math.floor(context.maxChars ?? RECALL_MAX_CHARS)));
  if (!budget) return [];
  const unique = [...new Set(scopes)];
  const batches = await Promise.all(
    unique.map(async (scope) => (await memory.recall(scope, context)).map((row) => ({ ...row, scope }))),
  );
  const ranked = batches.flat().sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0));
  const picked: RecalledFact[] = [];
  const headed = new Set<ScopeId>();
  const seen = new Set<string>();
  let size = 0;
  for (const { scope, id, text: full } of ranked) {
    if (!full.trim() || seen.has(full)) continue;
    const overhead = headed.has(scope) ? 1 : (headed.size ? 2 : 0) + heading(scope, labels).length + 1;
    const text = id === undefined ? full.slice(0, Math.max(0, budget - size - overhead)) : full;
    const cost = text.length + overhead;
    if (!text.trim() || size + cost > budget) continue;
    size += cost;
    seen.add(full);
    headed.add(scope);
    picked.push({ scope, ...(id !== undefined ? { id } : {}), text });
  }
  return picked;
}

export function renderRecall(facts: readonly RecalledFact[], labels: ReadonlyMap<string, string>): string {
  const groups = new Map<ScopeId, string[]>();
  for (const { scope, text } of facts) groups.set(scope, [...(groups.get(scope) ?? []), text]);
  return [...groups].map(([scope, rows]) => `${heading(scope, labels)}\n${rows.join("\n")}`).join("\n\n");
}

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

export async function searchNotebooks(
  memory: MemoryService,
  readable: readonly ScopeId[],
  query: string,
  limit: number | undefined,
  scope: ScopeId | undefined,
  actorId: string | undefined,
): Promise<string[] | null> {
  if (!readable.length || (scope !== undefined && !readable.includes(scope))) return null;
  const hits = await searchAcrossScopes(memory, scope === undefined ? readable : [scope], query, limit, { actorId });
  return hits.map((hit) => (readable.length > 1 || scope !== undefined ? `[${hit.scopeId}] ${hit.fact}` : hit.fact));
}

export async function readNotebook(memory: MemoryService, scope: ScopeId): Promise<string> {
  const facts = await memory.facts?.(scope);
  return facts ? facts.map(factLine).join("\n") : memory.read(scope);
}

export const canReadNotebook = (
  access: { read: readonly string[]; write?: string; orgWrite?: string },
  scope: string,
): boolean => access.read.includes(scope) || scope === access.write || scope === access.orgWrite;
