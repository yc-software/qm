import type { ScopeId } from "../types.ts";
import type { MemoryService, MemoryRecallContext } from "./memory-service.ts";
import { RECALL_MAX_CHARS } from "./notebook.ts";
import { factLine, type MemorySource } from "./facts.ts";
import { quotedData, untrustedText } from "../util/text.ts";

export interface RecalledFact {
  scope: ScopeId;
  id?: string;
  text: string;
  source?: MemorySource;
}

type Block = Pick<RecalledFact, "scope" | "source">;

const blockKey = ({ scope, source }: Block) => JSON.stringify([scope, source?.provider ?? null]);

export const recallLabel = (text: string) => untrustedText(text).replace(/\s+/g, " ");

const heading = ({ scope, source }: Block, labels: ReadonlyMap<string, string>) =>
  `### ${recallLabel(labels.get(scope) ?? scope)}${source ? ` · ${recallLabel(source.label)}` : ""}`;

const BLOCK_FRAME = quotedData("").length;

const quotedLength = (text: string) => quotedData(text).length - BLOCK_FRAME;

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
  const blocks = new Set<string>();
  const seen = new Set<string>();
  let size = 0;
  for (const row of ranked) {
    const { scope, id, text: full, source } = row;
    if (!full.trim() || seen.has(full)) continue;
    const overhead = blocks.has(blockKey(row))
      ? 1
      : (blocks.size ? 2 : 0) + heading(row, labels).length + 1 + BLOCK_FRAME;
    const room = Math.max(0, budget - size - overhead);
    const clipped = full.slice(0, room);
    const text = id === undefined ? clipped.slice(0, room - (quotedLength(clipped) - clipped.length)) : full;
    const cost = quotedLength(text) + overhead;
    if (!text.trim() || size + cost > budget) continue;
    size += cost;
    seen.add(full);
    blocks.add(blockKey(row));
    picked.push({ scope, ...(id !== undefined ? { id } : {}), text, ...(source ? { source } : {}) });
  }
  return picked;
}

export function renderRecall(facts: readonly RecalledFact[], labels: ReadonlyMap<string, string>): string {
  const blocks = new Map<string, { block: Block; rows: string[] }>();
  for (const fact of facts) {
    const key = blockKey(fact);
    const block = blocks.get(key) ?? { block: fact, rows: [] };
    block.rows.push(fact.text);
    blocks.set(key, block);
  }
  return [...blocks.values()]
    .map(({ block, rows }) => `${heading(block, labels)}\n${quotedData(rows.join("\n"))}`)
    .join("\n\n");
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
  const settled = await Promise.allSettled(unique.map((scope) => memory.query(scope, query, count, context)));
  const batches = settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
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
  report?: MemoryRecallContext["report"],
): Promise<string[] | null> {
  if (!readable.length || (scope !== undefined && !readable.includes(scope))) return null;
  const hits = await searchAcrossScopes(memory, scope === undefined ? readable : [scope], query, limit, {
    actorId,
    ...(report ? { report } : {}),
  });
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
