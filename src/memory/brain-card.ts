import type { DirectoryStore } from "../directory/directory-store.ts";
import { mentionedUserIds } from "../slack/mrkdwn.ts";
import type { ScopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { isObj } from "../util/objects.ts";
import { flatText } from "../util/text.ts";
import { renderCards, type RecalledFact } from "./cross-scope.ts";
import type { BoundBrain, MemoryAuthority, MemoryService } from "./memory-service.ts";
import { providerRef } from "./provider-router.ts";

const BRAIN_CARD_MAX_CHARS = 1_200;
const MAX_MENTIONS = 3;

type Row = Record<string, unknown>;

const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isObj) : []);

const words = (...parts: unknown[]) =>
  parts.flatMap((part) => (typeof part === "string" && flatText(part) ? [flatText(part)] : []));

export async function brainCards(input: {
  memory: MemoryService;
  brains: readonly BoundBrain[];
  scopeId: ScopeId;
  message: string;
  delivered: readonly { provider: string; ref: string }[];
  directory?: Pick<DirectoryStore, "getBySlackId">;
  by: MemoryAuthority;
  context: { audienceScopeId?: ScopeId; startedAt: number };
}): Promise<RecalledFact[]> {
  const { memory, scopeId, message, by, context } = input;
  const mentioned = await Promise.all(
    [...new Set(mentionedUserIds(message))]
      .slice(0, MAX_MENTIONS)
      .map((id) => input.directory?.getBySlackId(id).catch(swallowAs("brain card: mention", null))),
  );
  const names = mentioned.flatMap((member) => words(member?.displayName));
  const cardsOf = async (brain: BoundBrain): Promise<RecalledFact[]> => {
    const listed = new Set(brain.tools.map(({ name }) => name));
    const ask = async (tool: string, args: Row) =>
      ((await memory.lookup!(scopeId, providerRef(brain.id, tool), args, by, context)).structuredContent ?? {}) as Row;
    const card = (page: Row, ...summary: string[]): RecalledFact[] => {
      if (typeof page.source_id !== "string" || typeof page.slug !== "string") return [];
      const ref = providerRef(brain.id, `${page.source_id}:${page.slug}`);
      const text = flatText(`${brain.label} · ${ref} — ${summary.join(" ")}`);
      return [{ scope: scopeId, card: { provider: brain.id, ref }, text }];
    };
    const prior = input.delivered.filter(({ provider }) => provider === brain.id).map(({ ref }) => ref);
    const people = !listed.has("whois")
      ? []
      : names.map(async (name) => {
          const { matches, ambiguous } = await ask("whois", { query: name });
          const [match, ...others] = rows(matches);
          if (ambiguous === true || !match || others.length) return [];
          return card(match, ...words(match.title), ...words(match.type).map((type) => `(${type})`));
        });
    const volunteered = !listed.has("volunteer_context")
      ? []
      : ask("volunteer_context", {
          window: message,
          ...(prior.length ? { prior_context: prior.join("\n") } : {}),
        }).then(({ pages }) =>
          rows(pages).flatMap((page) => card(page, words(page.display, page.rationale).join(": "))),
        );
    return (await Promise.all([...people, volunteered])).flat();
  };
  const fitted: RecalledFact[] = [];
  const cards = await Promise.all(input.brains.map((brain) => cardsOf(brain).catch((): RecalledFact[] => [])));
  for (const card of cards.flat())
    if (
      !fitted.some((shown) => shown.card?.ref === card.card?.ref) &&
      renderCards([...fitted, card]).length <= BRAIN_CARD_MAX_CHARS
    )
      fitted.push(card);
  return fitted;
}
