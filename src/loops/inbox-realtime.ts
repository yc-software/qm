import { boundTenant } from "../tenants/context.ts";
import type { Loop } from "./types.ts";
import type { LoopStore } from "./loop-store.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import { conversationEvent, type IngressEntry } from "./ingress.ts";
import type { ConversationEvent } from "./sources/adapter.ts";
import { sourceAdapter } from "./sources/index.ts";
import { isResolved } from "./ledger-view.ts";

export interface InboxRealtimeDeps {
  loops: Pick<LoopStore, "inboxLoops">;
  items: Pick<LoopItemLedger, "byLoop">;
  enqueue: (loop: { id: string; owner: string }, entries: IngressEntry[]) => Promise<unknown>;
}

const LOOP_CACHE_TTL_MS = 60_000;

export function createInboxRealtime(deps: InboxRealtimeDeps): {
  onConversationEvent(event: ConversationEvent): Promise<void>;
} {
  const cache = new Map<string | undefined, { at: number; loops: Loop[] }>();

  async function inboxLoops(): Promise<Loop[]> {
    const tenant = boundTenant();
    const now = Date.now();
    const hit = cache.get(tenant);
    if (hit && now - hit.at <= LOOP_CACHE_TTL_MS) return hit.loops;
    const loops = await deps.loops.inboxLoops();
    cache.set(tenant, { at: now, loops });
    return loops;
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
            item.source === event.source &&
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
