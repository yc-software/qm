import type { ScopeId } from "../types.ts";
import type { MemoryService, MemoryRecallContext } from "./memory-service.ts";
import { RECALL_MAX_CHARS } from "./notebook.ts";
import { factLine, type MemoryCandidate, type MemorySource } from "./facts.ts";
import { quotedData, untrustedText } from "../util/text.ts";

export interface RecalledFact {
  scope: ScopeId;
  id?: string;
  ref?: string;
  text: string;
  also?: string[];
  source?: MemorySource;
}

type ScopedRow = MemoryCandidate & { scope: ScopeId; also?: string[] };

const alsoText = ({ also }: Pick<RecalledFact, "also">) => (also?.length ? ` (also ${also.join(", ")})` : "");

const naming = (copies: readonly ScopedRow[], row: ScopedRow): ScopedRow => {
  const also = [...new Set(copies.flatMap(({ ref }) => (ref !== undefined && ref !== row.ref ? [ref] : [])))];
  return also.length ? { ...row, also } : row;
};

function interleave(rows: readonly ScopedRow[]): ScopedRow[][] {
  const lists = new Map<string, ScopedRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.scope, row.source?.provider ?? null, row.arm ?? null]);
    const list = lists.get(key);
    if (list) list.push(row);
    else lists.set(key, [row]);
  }
  const copies = new Map<string, ScopedRow[]>();
  for (let i = 0, taken = 0; taken < rows.length; i++)
    for (const list of lists.values()) {
      const row = list[i];
      if (!row) continue;
      taken++;
      const claim = row.claim ?? row.text;
      const same = copies.get(claim);
      if (same) same.push(row);
      else copies.set(claim, [row]);
    }
  return [...copies.values()].map((same) => {
    const kept = same.find((row) => row.id !== undefined) ?? same[0]!;
    return [kept, ...same.filter((row) => row !== kept)];
  });
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
  const picked: RecalledFact[] = [];
  const blocks = new Set<string>();
  let size = 0;
  const place = (row: ScopedRow): boolean => {
    const { scope, id, ref, claim, text: full, also, source } = row;
    if (!full.trim()) return false;
    const overhead = blocks.has(blockKey(row))
      ? 1
      : (blocks.size ? 2 : 0) + heading(row, labels).length + 1 + BLOCK_FRAME;
    const suffix = alsoText(row);
    const room = Math.max(0, budget - size - overhead - suffix.length);
    const clipped = full.slice(0, room);
    const text = claim === undefined ? clipped.slice(0, room - (quotedLength(clipped) - clipped.length)) : full;
    const cost = quotedLength(text + suffix) + overhead;
    if (!text.trim() || size + cost > budget) return false;
    size += cost;
    blocks.add(blockKey(row));
    picked.push({
      scope,
      ...(id !== undefined ? { id } : {}),
      ...(ref !== undefined ? { ref } : {}),
      text,
      ...(also ? { also } : {}),
      ...(source ? { source } : {}),
    });
    return true;
  };
  for (const copies of interleave(batches.flat())) copies.some((copy) => place(naming(copies, copy)));
  return picked;
}

export function renderRecall(facts: readonly RecalledFact[], labels: ReadonlyMap<string, string>): string {
  const blocks = new Map<string, { block: Block; rows: string[] }>();
  for (const fact of facts) {
    const key = blockKey(fact);
    const block = blocks.get(key) ?? { block: fact, rows: [] };
    block.rows.push(fact.text + alsoText(fact));
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
  const rows = settled.flatMap((result, j) => {
    if (result.status === "rejected") throw result.reason;
    return result.value.map((row) => ({ ...row, scope: unique[j]! }));
  });
  return interleave(rows)
    .slice(0, count)
    .map((copies) => naming(copies, copies[0]!))
    .map((row) => ({ scopeId: row.scope, fact: row.text + alsoText(row) }));
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
