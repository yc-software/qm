import { retainedSnapshot } from "../agent/context-snapshot.ts";
import type { Item } from "../sessions/items.ts";
import { recallLabel, renderCards, renderRecall, type BrainCard, type RecalledFact } from "./cross-scope.ts";
import { factHash, renderFacts, type MemoryFact } from "./facts.ts";
import type { MemoryProviderOutcome } from "./memory-service.ts";
import { DENIED_CODES } from "./provider-outcome.ts";

interface Shown {
  scope: string;
  id?: string;
  provider?: string;
  hash: string;
}

type Card = Omit<BrainCard, "text">;

const BRAIN_CARD_MAX_CHARS = 1_200;

interface RecallRecord {
  shown: Shown[];
  cards?: Card[];
  anchorSeq?: number;
}

const recordHash = (text: string) => factHash(text).slice(0, 16);

const shownOf = ({ scope, id, text, source }: RecalledFact): Shown => ({
  scope,
  ...(id !== undefined ? { id } : {}),
  ...(source ? { provider: source.provider } : {}),
  hash: recordHash(text),
});

const cardOf = ({ scope, provider, endpoint, ref }: BrainCard): Card => ({ scope, provider, endpoint, ref });

const recordOf = (item: Item) => {
  const record = item.body.memoryRecall as RecallRecord | undefined;
  return record?.shown ? record : undefined;
};

export const deliveredCards = (history: readonly Item[]): Card[] =>
  retainedSnapshot(history, recordOf).previous?.cards ?? [];

export const shownFacts = (facts: readonly MemoryFact[]) => new Map(facts.map((fact) => [fact.id, fact]));

const stillHeld = (fact: MemoryFact | undefined, shown: Shown) =>
  !!fact && recordHash(renderFacts([fact])) === shown.hash;

const keyOf = ({ scope, id, provider, hash }: Shown) => JSON.stringify([scope, id ?? null, provider ?? null, hash]);

const cardKey = ({ endpoint, ref }: Card) => JSON.stringify([endpoint, ref]);

const sourceOf = ({ scope, provider }: Shown) => JSON.stringify([scope, provider ?? null]);

export function memoryRecallDelta(
  recalled: readonly RecalledFact[],
  history: readonly Item[],
  held: ReadonlyMap<string, ReadonlyMap<string, MemoryFact>>,
  labels: ReadonlyMap<string, string> = new Map(),
  outcomes: readonly MemoryProviderOutcome[] = [],
  brainCards: readonly BrainCard[] = [],
): { text: string; record: RecallRecord } {
  const { previous, anchorSeq } = retainedSnapshot(history, recordOf);
  const current = recalled.map(shownOf);
  const record: RecallRecord = { shown: current, ...(anchorSeq !== undefined ? { anchorSeq } : {}) };
  const seen = new Set(previous?.cards?.map(cardKey));
  const fitted: BrainCard[] = [];
  const dropped: string[] = [];
  for (const card of brainCards) {
    if (seen.has(cardKey(card))) continue;
    seen.add(cardKey(card));
    if (renderCards([...fitted, card]).length <= BRAIN_CARD_MAX_CHARS) fitted.push(card);
    else dropped.push(card.provider);
  }
  if (dropped.length)
    console.warn(
      `[memory] ${dropped.length} brain cards past the ${BRAIN_CARD_MAX_CHARS}-character block wait for a later turn, from ${[...new Set(dropped)].join(", ")}`,
    );
  const cards = fitted.map(cardOf);
  const newCards = renderCards(fitted);
  const outcomeOf = (shown: Pick<Shown, "scope" | "provider">) =>
    outcomes.find(({ provider, scope }) => provider === shown.provider && scope === shown.scope);
  const refused = (outcome: MemoryProviderOutcome | undefined) =>
    !outcome || ["denied", "disabled"].includes(outcome.outcome) || DENIED_CODES.has(outcome.code ?? "");
  let unauthorized = false;
  for (const card of previous?.cards ?? []) {
    if (!held.has(card.scope) || refused(outcomeOf(card))) unauthorized = true;
    else cards.push(card);
  }
  if (cards.length) record.cards = cards;
  if (!previous) return { text: [renderRecall(recalled, labels), newCards].filter(Boolean).join("\n\n"), record };
  const before = new Map(previous.shown.map((shown) => [keyOf(shown), shown]));
  const now = new Set(current.map(keyOf));
  const added = renderRecall(
    recalled.filter((_, index) => !before.has(keyOf(current[index]!))),
    labels,
  );
  const withdrawn = new Map<string, number>();
  const answered = new Map<string, number>();
  for (const shown of current)
    if (shown.id === undefined) answered.set(sourceOf(shown), (answered.get(sourceOf(shown)) ?? 0) + 1);
  const kept = new Map<string, number>();
  for (const [key, shown] of before) {
    if (now.has(key)) continue;
    if (!held.has(shown.scope)) {
      unauthorized = true;
    } else if (shown.id !== undefined) {
      if (stillHeld(held.get(shown.scope)?.get(shown.id), shown)) record.shown.push(shown);
      else withdrawn.set(shown.scope, (withdrawn.get(shown.scope) ?? 0) + 1);
    } else {
      const outcome = outcomeOf(shown);
      const source = sourceOf(shown);
      const room = outcome?.outcome === "ok" ? Math.max(1, answered.get(source) ?? 0) : Infinity;
      if (refused(outcome)) unauthorized = true;
      else if ((kept.get(source) ?? 0) < room) {
        record.shown.push(shown);
        kept.set(source, (kept.get(source) ?? 0) + 1);
      }
    }
  }
  return {
    text: [
      added ? `New or updated memory facts:\n\n${added}` : "",
      newCards,
      [...withdrawn]
        .map(
          ([scope, n]) =>
            `${recallLabel(labels.get(scope) ?? scope)}: ${n} earlier ${n === 1 ? "fact was" : "facts were"} consolidated or removed; rely only on the current list.`,
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
