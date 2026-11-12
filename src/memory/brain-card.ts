import type { DirectoryStore } from "../directory/directory-store.ts";
import { mentionedUserIds } from "../slack/mrkdwn.ts";
import type { ScopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { isObj } from "../util/objects.ts";
import { flatText } from "../util/text.ts";
import { renderCards, type BrainCard } from "./cross-scope.ts";
import type { BoundBrain, MemoryAuthority, MemoryService } from "./memory-service.ts";
import { providerRef } from "./provider-router.ts";
import { RECALL_MESSAGE_CHARS } from "./semantic-recall.ts";

const BRAIN_CARD_MAX_CHARS = 1_200;
const MAX_MENTIONS = 3;

type Page = Record<string, unknown> & { slug: string; source_id: string };

const isPage = (row: unknown): row is Page =>
  isObj(row) && typeof row.slug === "string" && typeof row.source_id === "string";

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
}): Promise<BrainCard[]> {
  const { memory, scopeId, message, by, context } = input;
  const names = input.brains.some(({ tools }) => tools.some(({ name }) => name === "whois"))
    ? Promise.all(
        [...new Set(mentionedUserIds(message))]
          .slice(0, MAX_MENTIONS)
          .map((id) => input.directory?.getBySlackId(id).catch(swallowAs("brain card: mention", null))),
      ).then((members) => members.flatMap((member) => words(member?.displayName)))
    : Promise.resolve([]);
  const cardsOf = async (brain: BoundBrain): Promise<BrainCard[]> => {
    const listed = new Set(brain.tools.map(({ name }) => name));
    const prior = new Set(input.delivered.filter(({ provider }) => provider === brain.id).map(({ ref }) => ref));
    const ask = async (tool: string, field: string, args: Record<string, unknown>) => {
      const answer =
        (await memory.lookup!(scopeId, providerRef(brain.id, tool), args, by, context)).structuredContent ?? {};
      const pages: unknown = answer[field];
      if (!Array.isArray(pages) || !pages.every(isPage))
        throw new Error(
          `${tool} from ${brain.id} answered without ${field} as a list of pages with slug and source_id`,
        );
      return { pages, ambiguous: answer.ambiguous === true };
    };
    const card = (page: Page, ...summary: string[]): BrainCard[] => {
      const ref = providerRef(brain.id, `${page.source_id}:${page.slug}`);
      return prior.has(ref)
        ? []
        : [{ scope: scopeId, provider: brain.id, ref, text: flatText(`${ref} — ${summary.join(" ")}`) }];
    };
    const settle = (tool: string, cards: Promise<BrainCard[]>) =>
      cards.catch(swallowAs(`brain card: ${brain.id} ${tool}`, []));
    const whois = async (name: string) => {
      const {
        pages: [match, ...others],
        ambiguous,
      } = await ask("whois", "matches", { query: name });
      if (ambiguous || !match || others.length) return [];
      return card(match, ...words(match.title), ...words(match.type).map((type) => `(${type})`));
    };
    const volunteered = async () => {
      const { pages } = await ask("volunteer_context", "pages", {
        window: message.slice(0, RECALL_MESSAGE_CHARS),
        ...(prior.size ? { prior_context: [...prior].join("\n") } : {}),
      });
      return pages.flatMap((page) => card(page, ...words(page.display)));
    };
    const volunteering = listed.has("volunteer_context") ? [settle("volunteer_context", volunteered())] : [];
    const people = listed.has("whois") ? (await names).map((name) => settle("whois", whois(name))) : [];
    return (await Promise.all([...people, ...volunteering])).flat();
  };
  const fitted: BrainCard[] = [];
  for (const card of (await Promise.all(input.brains.map(cardsOf))).flat())
    if (!fitted.some(({ ref }) => ref === card.ref) && renderCards([...fitted, card]).length <= BRAIN_CARD_MAX_CHARS)
      fitted.push(card);
  return fitted;
}
