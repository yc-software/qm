import { parseSuggestedActivities, type SuggestedActivity } from "../../plugins/chassis/src/suggested-activities.ts";
import { loopItemId, type LoopItemLedger } from "../loops/item-ledger.ts";
import type { SystemLoopPass } from "../loops/loop-fire.ts";
import type { LoopStore } from "../loops/loop-store.ts";
import type { Loop, LoopItem } from "../loops/types.ts";
import { scopeId } from "../types.ts";
import { suggestionsPrompt } from "./prompt.ts";

export const SUGGESTIONS_SURFACE = "system:suggestions";
export const GENERATED_COUNT = 5;
export const VISIBLE_COUNT = 3;
const MAX_DISMISSED = 30;
const DISMISSED = "dismissed";
const STOCK_PLAYBOOK = "Generate suggested activities with the built-in suggestions task.";

export interface SuggestionBatch {
  activities: SuggestedActivity[];
  depth: number;
  batchSize: number;
  batchAt: number;
  dismissed: Set<string>;
}

type SuggestionItemDeps = {
  loops: LoopStore;
  items: LoopItemLedger;
};

const activityOf = (item: LoopItem): SuggestedActivity => {
  const payload = item.proposal?.data ?? {};
  return {
    id: item.sourceKey,
    title: String(payload.title ?? ""),
    prompt: String(payload.prompt ?? ""),
    icon: String(payload.icon ?? ""),
  };
};

const batchAtOf = (item: LoopItem) => Number(item.sourcePayload?.batchAt ?? 0);
const rankOf = (item: LoopItem) => Number(item.sourcePayload?.rank ?? 0);

export function createSuggestionItems(deps: SuggestionItemDeps) {
  const closeAs = (loopId: string, id: string, kind: string) =>
    deps.items.recordAction(loopItemId(loopId, id), { kind, outcome: "dismissed" });

  const record = async (
    loopId: string,
    activities: Array<SuggestedActivity & { rank: number }>,
    batchAt: number,
  ): Promise<void> => {
    await deps.items.ingest(
      activities.map(({ rank, ...activity }) => ({
        loopId,
        dedupeKey: activity.id,
        source: SUGGESTIONS_SURFACE,
        summary: activity.title,
        sourcePayload: { rank, batchAt },
        proposal: { data: { title: activity.title, prompt: activity.prompt, icon: activity.icon }, by: "agent" },
      })),
    );
  };

  const newestDismissed = (items: LoopItem[]) =>
    items
      .filter((item) => item.actionKind === DISMISSED)
      .toSorted((a, b) => (a.actedAt ?? 0) - (b.actedAt ?? 0))
      .slice(-MAX_DISMISSED);

  return {
    async ensureLoop(owner: string): Promise<Loop> {
      const ownerScopeId = scopeId("personal", owner);
      const { loop } = await deps.loops.create({
        owner,
        createdBy: owner,
        taskAuthor: "automation",
        ownerScopeId,
        name: "Suggested activities",
        surface: SUGGESTIONS_SURFACE,
        purpose: "Suggested activities for the new-chat screen.",
        playbook: STOCK_PLAYBOOK,
        successCondition: "The new-chat screen has current suggestions.",
      });
      return loop;
    },

    getLoop: (loopId: string) => deps.loops.get(loopId),

    async bind(loop: Loop, cronId: string): Promise<void> {
      if (loop.cronId !== cronId) await deps.loops.update(loop.id, { cronId });
    },

    async current(loopId: string): Promise<SuggestionBatch> {
      const all = await deps.items.byLoop(loopId);
      const batchAt = Math.max(0, ...all.map(batchAtOf));
      const open = all
        .filter((item) => item.status === "ready")
        .toSorted((a, b) => batchAtOf(b) - batchAtOf(a) || rankOf(a) - rankOf(b));
      return {
        activities: open.map(activityOf),
        depth: open.length,
        batchSize: all.filter((item) => batchAtOf(item) === batchAt).length,
        batchAt,
        dismissed: new Set(all.filter((item) => item.actionKind === DISMISSED).map((item) => item.sourceKey)),
      };
    },

    async dismiss(loopId: string, id: string, fallback?: SuggestedActivity): Promise<boolean> {
      const item = await deps.items.get(loopItemId(loopId, id));
      if (item?.status === "ready") return !!(await closeAs(loopId, id, DISMISSED));
      if (item || !fallback) return false;
      await record(loopId, [{ ...fallback, rank: 0 }], 0);
      return !!(await closeAs(loopId, id, DISMISSED));
    },

    async dismissedTitles(loopId: string): Promise<string[]> {
      return newestDismissed(await deps.items.byLoop(loopId)).map((item) => activityOf(item).title);
    },

    async replaceBatch(loopId: string, activities: SuggestedActivity[], batchAt: number): Promise<void> {
      await record(
        loopId,
        activities.map((activity, rank) => ({ ...activity, rank })),
        batchAt,
      );
      const incoming = new Set(activities.map((activity) => activity.id));
      const all = await deps.items.byLoop(loopId);
      const kept = new Set(newestDismissed(all).map((item) => item.id));
      await deps.items.remove(
        all
          .filter((item) =>
            item.actionKind === DISMISSED
              ? !kept.has(item.id)
              : item.status === "ready" && !incoming.has(item.sourceKey),
          )
          .map((item) => item.id),
      );
    },
  };
}

export type SuggestionItems = ReturnType<typeof createSuggestionItems>;

export function createSuggestionsPass(deps: {
  suggestions: SuggestionItems;
  seeds: (owner: string) => Promise<SuggestedActivity[]>;
  context?: string;
}): SystemLoopPass {
  return {
    async prompt(loop) {
      return suggestionsPrompt({
        ...(deps.context ? { context: deps.context } : {}),
        seeds: await deps.seeds(loop.owner),
        dismissed: await deps.suggestions.dismissedTitles(loop.id),
      });
    },
    async ingest(loop, reply, at) {
      const activities = (() => {
        try {
          return parseSuggestedActivities(reply.trim());
        } catch (cause) {
          throw new Error("the suggestions reply is not a valid list of activities", { cause });
        }
      })();
      if (activities.length < VISIBLE_COUNT || activities.length > GENERATED_COUNT)
        throw new Error(`expected ${VISIBLE_COUNT} to ${GENERATED_COUNT} suggestions, got ${activities.length}`);
      await deps.suggestions.replaceBatch(loop.id, activities, at);
      return `${activities.length} suggestions`;
    },
  };
}
