import type { LoopStore } from "./loop-store.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import { conversationEvent, type IngressEntry } from "./ingress.ts";
import type { ConversationEvent } from "./sources/adapter.ts";
import { sourceAdapter } from "./sources/index.ts";
import { isResolved } from "./ledger-view.ts";

export interface InboxRealtimeDeps {
  loops: Pick<LoopStore, "list">;
  items: Pick<LoopItemLedger, "byLoop">;
  enqueue: (loop: { id: string; owner: string }, entries: IngressEntry[]) => Promise<unknown>;
}

const LOOP_CACHE_TTL_MS = 60_000;

export function createInboxRealtime(deps: InboxRealtimeDeps): {
  onConversationEvent(event: ConversationEvent): Promise<void>;
} {
  let cachedInboxLoops: Array<{ id: string; owner: string }> = [];
  let cacheAt = 0;

  async function inboxLoops(): Promise<Array<{ id: string; owner: string }>> {
    const now = Date.now();
    if (now - cacheAt > LOOP_CACHE_TTL_MS) {
      const all = await deps.loops.list();
      cachedInboxLoops = all
        .filter((loop) => (loop.surface === "inbox" || loop.surface?.startsWith("inbox:")) && loop.state !== "archived")
        .map((loop) => ({ id: loop.id, owner: loop.owner }));
      cacheAt = now;
    }
    return cachedInboxLoops;
  }

  return {
    async onConversationEvent(event) {
      if (!Number.isFinite(event.at)) return;
      const adapter = sourceAdapter(event.source);
      if (!adapter) return;
      for (const loop of await inboxLoops()) {
        const owner = Boolean(event.senderEmail && event.senderEmail.toLowerCase() === loop.owner.toLowerCase());
        const matched = (await deps.items.byLoop(loop.id)).filter(
          (item) =>
            (item.source ?? item.sourcePayload?.source) === event.source &&
            adapter.matchesEvent(item, event.conversationRef) &&
            !(owner && isResolved(item)),
        );
        if (!matched.length) continue;
        const latest = {
          author: owner ? ("owner" as const) : ("other" as const),
          at: event.at,
          ...(event.text ? { text: event.text } : {}),
          ...(event.senderEmail ? { from: event.senderEmail } : {}),
        };
        await deps.enqueue(
          loop,
          matched.map((item) => conversationEvent(item, latest)),
        );
      }
    },
  };
}
