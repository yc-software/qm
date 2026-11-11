import type { ScopeId } from "../types.ts";
import type { MemoryService, MemoryRecallContext } from "./memory-service.ts";
import { RECALL_MAX_CHARS } from "./notebook.ts";
import { factLine, fromOtherSession, normalizeClaim, type MemoryCandidate, type MemorySource } from "./facts.ts";
import { quotedData, untrustedText } from "../util/text.ts";

export interface RecalledFact {
  scope: ScopeId;
  id?: string;
  text: string;
  source?: MemorySource;
}

export interface BrainCard {
  scope: ScopeId;
  provider: string;
  ref: string;
  text: string;
}

type ScopedRow = MemoryCandidate & { scope: ScopeId };

type Block = Pick<RecalledFact, "scope" | "source">;

const blockKey = ({ scope, source }: Block) => JSON.stringify([scope, source?.provider ?? null]);

const claimOf = (row: ScopedRow) => normalizeClaim(row.claim ?? row.text);

function copiesInTurn(rows: readonly ScopedRow[]): ScopedRow[][] {
  const copies = Map.groupBy(rows, claimOf);
  const kept = new Set([...copies.values()].map((same) => same.find((row) => row.id !== undefined) ?? same[0]!));
  const keptRows = rows.filter((row) => kept.has(row));
  const lists = [...Map.groupBy(keptRows, blockKey).values()];
  const rounds = Math.max(0, ...lists.map((list) => list.length));
  const turns = Array.from({ length: rounds }, (_, i) => lists.flatMap((list) => list.slice(i, i + 1)));
  return turns.flat().map((row) => [row, ...copies.get(claimOf(row))!.filter((copy) => copy !== row)]);
}

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
    unique.map(async (scope) =>
      (await memory.recall(scope, context))
        .filter((row) => fromOtherSession(row, context.sessionId))
        .map((row) => ({ ...row, scope })),
    ),
  );
  const picked: RecalledFact[] = [];
  const blocks = new Set<string>();
  let size = 0;
  const place = (row: ScopedRow): boolean => {
    const { scope, id, claim, text: full, source } = row;
    if (!full.trim()) return false;
    const overhead = blocks.has(blockKey(row))
      ? 1
      : (blocks.size ? 2 : 0) + heading(row, labels).length + 1 + BLOCK_FRAME;
    const room = Math.max(0, budget - size - overhead);
    const clipped = full.slice(0, room);
    const text = claim === undefined ? clipped.slice(0, room - (quotedLength(clipped) - clipped.length)) : full;
    const cost = quotedLength(text) + overhead;
    if (!text.trim() || size + cost > budget) return false;
    size += cost;
    blocks.add(blockKey(row));
    picked.push({ scope, ...(id !== undefined ? { id } : {}), text, ...(source ? { source } : {}) });
    return true;
  };
  for (const copies of copiesInTurn(batches.flat())) copies.some(place);
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

export const renderCards = (cards: readonly BrainCard[]): string =>
  cards.length ? `### Brain cards\n${quotedData(cards.map(({ text }) => text).join("\n"))}` : "";

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
  return copiesInTurn(rows)
    .slice(0, count)
    .map(([kept, ...others]) => {
      const also = [
        ...new Set(others.flatMap(({ ref, id, scope }) => ref ?? (id === undefined ? [] : [`[${scope}] #${id}`]))),
      ].filter((address) => address !== kept!.ref);
      const address = kept!.ref === undefined ? "" : `${kept!.ref} `;
      return {
        scopeId: kept!.scope,
        fact: `${address}${kept!.text}${also.length ? ` (also ${also.join(", ")})` : ""}`,
      };
    });
}

export async function searchNotebooks(
  memory: MemoryService,
  readable: readonly ScopeId[],
  query: string,
  limit: number | undefined,
  scope: ScopeId | undefined,
  context: MemoryRecallContext,
): Promise<string[] | null> {
  if (!readable.length || (scope !== undefined && !readable.includes(scope))) return null;
  const hits = await searchAcrossScopes(memory, scope === undefined ? readable : [scope], query, limit, context);
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
