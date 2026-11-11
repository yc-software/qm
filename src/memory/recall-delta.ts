import { retainedSnapshot } from "../agent/context-snapshot.ts";
import type { Item } from "../sessions/items.ts";
import { recallLabel, renderCards, renderRecall, type RecalledFact } from "./cross-scope.ts";
import { factHash, renderFacts, type MemoryFact } from "./facts.ts";
import type { MemoryProviderOutcome } from "./memory-service.ts";
import { DENIED_CODES } from "./provider-outcome.ts";

interface Shown {
  scope: string;
  id?: string;
  provider?: string;
  hash: string;
}

interface Card {
  scope: string;
  provider: string;
  ref: string;
  hash: string;
}

interface RecallRecord {
  shown: Shown[];
  cards?: Card[];
  anchorSeq?: number;
}

const shownOf = ({ scope, id, text, source }: RecalledFact): Shown => ({
  scope,
  ...(id !== undefined ? { id } : {}),
  ...(source ? { provider: source.provider } : {}),
  hash: factHash(text).slice(0, 16),
});

const cardOf = ({ scope, card, text }: RecalledFact): Card[] =>
  card ? [{ scope, ...card, hash: factHash(text).slice(0, 16) }] : [];

const recordOf = (item: Item) => {
  const record = item.body.memoryRecall as RecallRecord | undefined;
  return record?.shown ? record : undefined;
};

export const deliveredCards = (history: readonly Item[]): Card[] =>
  retainedSnapshot(history, recordOf).previous?.cards ?? [];

export const shownFacts = (facts: readonly MemoryFact[]) => new Map(facts.map((fact) => [fact.id, fact]));

const stillHeld = (fact: MemoryFact | undefined, shown: Shown) =>
  !!fact && shownOf({ scope: "", id: fact.id, text: renderFacts([fact]) }).hash === shown.hash;

const keyOf = ({ scope, id, provider, hash }: Shown) => JSON.stringify([scope, id ?? null, provider ?? null, hash]);

const cardKey = ({ scope, ref, hash }: Card) => JSON.stringify([scope, ref, hash]);

const sourceOf = ({ scope, provider }: Shown) => JSON.stringify([scope, provider ?? null]);

export function memoryRecallDelta(
  recalled: readonly RecalledFact[],
  history: readonly Item[],
  held: ReadonlyMap<string, ReadonlyMap<string, MemoryFact>>,
  labels: ReadonlyMap<string, string> = new Map(),
  outcomes: readonly MemoryProviderOutcome[] = [],
): { text: string; record: RecallRecord } {
  const { previous, anchorSeq } = retainedSnapshot(history, recordOf);
  const facts = recalled.filter(({ card }) => !card);
  const cardFacts = recalled.filter(({ card }) => card);
  const current = facts.map(shownOf);
  const cards = cardFacts.flatMap(cardOf);
  const record: RecallRecord = { shown: current, ...(anchorSeq !== undefined ? { anchorSeq } : {}) };
  const shownCards = new Set(previous?.cards?.map(cardKey));
  const newCards = renderCards(cardFacts.filter((_, index) => !shownCards.has(cardKey(cards[index]!))));
  const withCards = (text: string) => [text, newCards].filter(Boolean).join("\n\n");
  const outcomeOf = (shown: Pick<Shown, "scope" | "provider">) =>
    outcomes.find(({ provider, scope }) => provider === shown.provider && scope === shown.scope);
  const refused = (outcome: MemoryProviderOutcome | undefined) =>
    !outcome || ["denied", "disabled"].includes(outcome.outcome) || DENIED_CODES.has(outcome.code ?? "");
  let unauthorized = false;
  for (const card of previous?.cards ?? []) {
    if (cards.some(({ ref }) => ref === card.ref)) continue;
    if (!held.has(card.scope) || refused(outcomeOf(card))) unauthorized = true;
    else cards.push(card);
  }
  if (cards.length) record.cards = cards;
  if (!previous) return { text: withCards(renderRecall(facts, labels)), record };
  const before = new Map(previous.shown.map((shown) => [keyOf(shown), shown]));
  const now = new Set(current.map(keyOf));
  const added = withCards(
    renderRecall(
      facts.filter((_, index) => !before.has(keyOf(current[index]!))),
      labels,
    ),
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
