import type { LoopStore } from "./loop-store.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import { conversationChanged, type IngressEntry } from "./ingress.ts";
import type { ConversationEvent } from "./sources/adapter.ts";
import { sourceAdapter } from "./sources/index.ts";
import { currentTenant } from "../tenants/context.ts";

export interface InboxRealtimeDeps {
  loops: Pick<LoopStore, "list">;
  items: Pick<LoopItemLedger, "byLoop">;
  enqueue: (loop: { id: string; owner: string }, entries: IngressEntry[]) => Promise<unknown>;
}

const LOOP_CACHE_TTL_MS = 60_000;

export function createInboxRealtime(deps: InboxRealtimeDeps): {
  onConversationEvent(event: ConversationEvent): Promise<void>;
} {
  const cachedInboxLoops = new Map<string, { at: number; loops: Array<{ id: string; owner: string }> }>();

  async function inboxLoops(): Promise<Array<{ id: string; owner: string }>> {
    const now = Date.now();
    const tenant = currentTenant();
    const cached = cachedInboxLoops.get(tenant);
    if (cached && now - cached.at <= LOOP_CACHE_TTL_MS) return cached.loops;
    const loops = (await deps.loops.list())
      .filter((loop) => loop.surface?.startsWith("inbox:") && loop.state !== "archived")
      .map((loop) => ({ id: loop.id, owner: loop.owner }));
    cachedInboxLoops.set(tenant, { at: now, loops });
    return loops;
  }

  return {
    async onConversationEvent(event) {
      if (!Number.isFinite(event.at)) return;
      const adapter = sourceAdapter(event.source);
      if (!adapter) return;
      for (const loop of await inboxLoops()) {
        const matched = (await deps.items.byLoop(loop.id)).filter(
          (item) => item.source === event.source && adapter.matchesEvent(item, event.conversationRef),
        );
        if (!matched.length) continue;
        await deps.enqueue(
          loop,
          matched.map((item) => conversationChanged(item, event.at)),
        );
      }
    },
  };
}
