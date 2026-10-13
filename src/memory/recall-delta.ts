import { retainedSnapshot } from "../harness/context-snapshot.ts";
import type { SessionEntry } from "../types.ts";
import { renderRecall, type RecalledFact } from "./cross-scope.ts";
import { factHash, renderFacts, type MemoryFact } from "./facts.ts";

interface Shown {
  scope: string;
  id?: string;
  hash: string;
}

interface RecallRecord {
  shown: Shown[];
  anchorSeq?: number;
}

const shownOf = ({ scope, id, text }: RecalledFact): Shown => ({
  scope,
  ...(id !== undefined ? { id } : {}),
  hash: factHash(text).slice(0, 16),
});

export const shownFacts = (facts: readonly MemoryFact[]) =>
  new Map(facts.map((fact) => [fact.id, shownOf({ scope: "", id: fact.id, text: renderFacts([fact]) }).hash]));

const keyOf = ({ scope, id, hash }: Shown) => JSON.stringify([scope, id ?? null, hash]);

export function memoryRecallDelta(
  recalled: readonly RecalledFact[],
  history: readonly SessionEntry[],
  held: ReadonlyMap<string, ReadonlyMap<string, string>>,
  labels: ReadonlyMap<string, string> = new Map(),
): { text: string; record: RecallRecord } {
  const { previous, anchorSeq } = retainedSnapshot(history, (entry) => {
    const record = (entry.payload as { memoryRecall?: RecallRecord } | null)?.memoryRecall;
    return record?.shown ? record : undefined;
  });
  const current = recalled.map(shownOf);
  const record: RecallRecord = { shown: current, ...(anchorSeq !== undefined ? { anchorSeq } : {}) };
  if (!previous) return { text: renderRecall(recalled, labels), record };
  const before = new Map(previous.shown.map((shown) => [keyOf(shown), shown]));
  const now = new Set(current.map(keyOf));
  const added = recalled.filter((_, index) => !before.has(keyOf(current[index]!)));
  const removed = new Map<string, number>();
  for (const [key, shown] of before) {
    if (now.has(key)) continue;
    if (shown.id !== undefined && held.get(shown.scope)?.get(shown.id) === shown.hash) record.shown.push(shown);
    else removed.set(shown.scope, (removed.get(shown.scope) ?? 0) + 1);
  }
  const withdrawn = [...removed].filter(([scope]) => held.has(scope));
  return {
    text: [
      added.length ? `New or updated memory facts:\n\n${renderRecall(added, labels)}` : "",
      withdrawn
        .map(
          ([scope, n]) =>
            `${labels.get(scope) ?? scope}: ${n} earlier ${n === 1 ? "fact was" : "facts were"} consolidated or removed; rely only on the current list.`,
        )
        .join("\n"),
      removed.size > withdrawn.length
        ? "Some previously recalled memory sources are no longer included. Do not rely on memory from sources that are not currently authorized."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    record,
  };
}
