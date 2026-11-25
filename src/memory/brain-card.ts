import type { DirectoryStore } from "../directory/directory-store.ts";
import { mentionedUserIds, resolveMentions } from "../slack/mrkdwn.ts";
import type { ScopeId } from "../types.ts";
import { withTimeout } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { isObj } from "../util/objects.ts";
import { flatText } from "../util/text.ts";
import type { BrainCard } from "./cross-scope.ts";
import type { BoundBrain, MemoryAuthority, MemoryService } from "./memory-service.ts";
import { providerRef } from "./provider-router.ts";
import { RECALL_MESSAGE_CHARS } from "./semantic-recall.ts";

type Page = Record<string, unknown> & { slug: string; source_id: string };

const isPage = (row: unknown): row is Page =>
  isObj(row) && typeof row.slug === "string" && typeof row.source_id === "string";

export async function brainCards(input: {
  memory: MemoryService;
  brains: readonly BoundBrain[];
  scopeId: ScopeId;
  message: string;
  delivered: readonly Pick<BrainCard, "provider" | "endpoint" | "ref">[];
  directory?: Pick<DirectoryStore, "getBySlackIds">;
  by: MemoryAuthority;
  context: { audienceScopeId?: ScopeId; startedAt: number };
}): Promise<BrainCard[]> {
  const { memory, scopeId, message, by, context } = input;
  const brains = input.brains.filter(({ tools }) => tools.some(({ name }) => name === "volunteer_context"));
  const mentioned = [...new Set(mentionedUserIds(message))];
  const named =
    brains.length && mentioned.length && input.directory
      ? input.directory
          .getBySlackIds(mentioned)
          .then((members) =>
            resolveMentions(message, new Map([...members].map(([id, { displayName }]) => [id, displayName]))),
          )
          .catch(swallowAs("brain card: mentioned names", message))
      : Promise.resolve(message);
  const cardsOf = async (brain: BoundBrain): Promise<BrainCard[]> => {
    const prior = input.delivered
      .filter(({ provider, endpoint }) => provider === brain.id && endpoint === brain.endpoint)
      .map(({ ref }) => ref)
      .join("\n");
    const window = await withTimeout(() => named, context.startedAt + brain.timeoutMs - Date.now(), "mentioned names");
    const { pages } =
      (
        await memory.lookup!(
          scopeId,
          providerRef(brain.id, "volunteer_context"),
          { window: window.slice(0, RECALL_MESSAGE_CHARS), ...(prior ? { prior_context: prior } : {}) },
          by,
          context,
        )
      ).structuredContent ?? {};
    if (!Array.isArray(pages) || !pages.every(isPage))
      throw new Error(
        `volunteer_context from ${brain.id} answered without pages as a list of pages with slug and source_id`,
      );
    return pages.map((page) => {
      const ref = providerRef(brain.id, `${page.source_id}:${page.slug}`);
      const name = typeof page.display === "string" ? page.display : "";
      return { scope: scopeId, provider: brain.id, endpoint: brain.endpoint, ref, text: flatText(`${ref} — ${name}`) };
    });
  };
  return (
    await Promise.all(
      brains.map((brain) => cardsOf(brain).catch(swallowAs(`brain card: ${brain.id} volunteer_context`, []))),
    )
  ).flat();
}
