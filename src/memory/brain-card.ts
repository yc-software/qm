import type { DirectoryStore } from "../directory/directory-store.ts";
import { mentionedUserIds } from "../slack/mrkdwn.ts";
import type { ScopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { flatText } from "../util/text.ts";
import { renderRecall, type RecalledFact } from "./cross-scope.ts";
import type { BoundBrain, MemoryAuthority, MemoryService } from "./memory-service.ts";
import { providerRef } from "./provider-router.ts";

const BRAIN_CARD_MAX_CHARS = 1_200;
const MAX_MENTIONS = 3;

type Row = Record<string, unknown>;

const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === "object") : [];

const words = (...parts: unknown[]) =>
  parts.flatMap((part) => (typeof part === "string" && flatText(part) ? [flatText(part)] : []));

export async function brainCards(input: {
  memory: MemoryService;
  brains: readonly BoundBrain[];
  scopeId: ScopeId;
  message: string;
  delivered: readonly string[];
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
    const card = (page: Row | undefined, ...summary: string[]): RecalledFact[] => {
      if (typeof page?.source_id !== "string" || typeof page.slug !== "string") return [];
      const ref = `${brain.id}:${page.source_id}:${page.slug}`;
      const text = flatText(`${brain.label} · ${ref} — ${summary.join(" ")}`);
      return [{ scope: scopeId, source: { provider: brain.id, label: brain.label }, ref, kind: "card", text }];
    };
    const prior = input.delivered.filter((ref) => ref.startsWith(`${brain.id}:`));
    const entities = !(listed.has("whois") && listed.has("entity"))
      ? []
      : names.map(async (name) => {
          const { matches, ambiguous } = await ask("whois", { query: name });
          const [match, ...others] = rows(matches);
          if (ambiguous === true || !match || others.length) return [];
          const { card: found } = await ask("entity", { name: match.slug, source_id: match.source_id });
          const { entity } = (found ?? {}) as { entity?: Row };
          return card(entity, ...words(entity?.title), ...words(entity?.type).map((type) => `(${type})`));
        });
    const volunteered = !listed.has("volunteer_context")
      ? []
      : ask("volunteer_context", {
          window: message,
          ...(prior.length ? { prior_context: prior.join("\n") } : {}),
        }).then(({ pages }) =>
          rows(pages).flatMap((page) => card(page, words(page.display, page.rationale).join(": "))),
        );
    return (await Promise.all([...entities, volunteered])).flat();
  };
  const fitted: RecalledFact[] = [];
  const cards = await Promise.all(input.brains.map((brain) => cardsOf(brain).catch((): RecalledFact[] => [])));
  for (const card of cards.flat())
    if (
      !fitted.some(({ ref }) => ref === card.ref) &&
      renderRecall([...fitted, card], new Map()).length <= BRAIN_CARD_MAX_CHARS
    )
      fitted.push(card);
  return fitted;
}
