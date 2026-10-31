import { retainedSnapshot } from "../agent/context-snapshot.ts";
import type { SessionEntry } from "../types.ts";
import { untrustedText } from "../util/text.ts";
import { renderRecall, type RecalledFact } from "./cross-scope.ts";
import { factHash, renderFacts, type MemoryFact } from "./facts.ts";
import type { MemoryProviderOutcome } from "./memory-service.ts";
import { refused } from "./provider-outcome.ts";

interface Shown {
  scope: string;
  id?: string;
  provider?: string;
  hash: string;
}

interface RecallRecord {
  shown: Shown[];
  anchorSeq?: number;
}

const shownOf = ({ scope, id, text, source }: RecalledFact): Shown => ({
  scope,
  ...(id !== undefined ? { id } : {}),
  ...(source ? { provider: source.provider } : {}),
  hash: factHash(text).slice(0, 16),
});

export const shownFacts = (facts: readonly MemoryFact[]) => new Map(facts.map((fact) => [fact.id, fact]));

const stillHeld = (fact: MemoryFact | undefined, shown: Shown) =>
  !!fact && shownOf({ scope: "", id: fact.id, text: renderFacts([fact]) }).hash === shown.hash;

const keyOf = ({ scope, id, hash }: Shown) => JSON.stringify([scope, id ?? null, hash]);

const KEPT_WHEN: ReadonlySet<MemoryProviderOutcome["outcome"]> = new Set(["empty", "timed_out", "failed"]);

export function memoryRecallDelta(
  recalled: readonly RecalledFact[],
  history: readonly SessionEntry[],
  held: ReadonlyMap<string, ReadonlyMap<string, MemoryFact>>,
  labels: ReadonlyMap<string, string> = new Map(),
  outcomes: readonly MemoryProviderOutcome[] = [],
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
  const withdrawn = new Map<string, number>();
  let unauthorized = false;
  for (const [key, shown] of before) {
    if (now.has(key)) continue;
    if (!held.has(shown.scope)) {
      unauthorized = true;
    } else if (shown.id !== undefined) {
      if (stillHeld(held.get(shown.scope)?.get(shown.id), shown)) record.shown.push(shown);
      else withdrawn.set(shown.scope, (withdrawn.get(shown.scope) ?? 0) + 1);
    } else {
      const outcome = outcomes.find(({ provider, scope }) => provider === shown.provider && scope === shown.scope);
      if (outcome && refused(outcome)) unauthorized = true;
      else if (outcome && KEPT_WHEN.has(outcome.outcome)) record.shown.push(shown);
    }
  }
  return {
    text: [
      added.length ? `New or updated memory facts:\n\n${renderRecall(added, labels)}` : "",
      [...withdrawn]
        .map(
          ([scope, n]) =>
            `${untrustedText(labels.get(scope) ?? scope)}: ${n} earlier ${n === 1 ? "fact was" : "facts were"} consolidated or removed; rely only on the current list.`,
        )
        .join("\n"),
      unauthorized
        ? "Some previously recalled memory sources are no longer included. Do not rely on memory from sources that are not currently authorized."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    record,
  };
}
