import type { LoopItem } from "../types.ts";
import type { LoopStore } from "./loop-store.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import type { ConversationEvent } from "./sources/adapter.ts";
import { sourceAdapter } from "./sources/index.ts";
import { swallow } from "../util/errors.ts";

export interface InboxRealtimeDeps {
  loops: Pick<LoopStore, "list">;
  items: Pick<LoopItemLedger, "byLoop" | "recordAction" | "ingest">;
  requestFire?: (loopId: string) => void;
}

const OPEN_STATUSES = new Set(["queued", "in_progress", "ready", "failed"]);
const LOOP_CACHE_TTL_MS = 60_000;
const FIRE_DEBOUNCE_MS = 30_000;
const MAX_REPLY_CHARS = 500;
const MAX_SNIPPET_CHARS = 200;

export function createInboxRealtime(deps: InboxRealtimeDeps): {
  onConversationEvent(event: ConversationEvent): Promise<void>;
} {
  let cachedInboxLoops: Array<{ id: string; owner: string }> = [];
  let cacheAt = 0;
  const lastFireAt = new Map<string, number>();

  async function inboxLoops(): Promise<Array<{ id: string; owner: string }>> {
    const now = Date.now();
    if (now - cacheAt > LOOP_CACHE_TTL_MS) {
      const all = await deps.loops.list();
      cachedInboxLoops = all
        .filter((loop) => loop.surface === "inbox")
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
        let matched: LoopItem[];
        try {
          const items = await deps.items.byLoop(loop.id);
          matched = items.filter(
            (item) =>
              OPEN_STATUSES.has(item.status) &&
              (item.source ?? item.sourcePayload?.source) === event.source &&
              adapter.matchesEvent(item, event.conversationRef),
          );
        } catch (e) {
          swallow("inbox realtime: read ledger", e);
          continue;
        }
        if (!matched.length) continue;
        const ownerReplied = Boolean(event.senderEmail && event.senderEmail.toLowerCase() === loop.owner.toLowerCase());
        for (const item of matched) {
          try {
            if (ownerReplied) {
              await deps.items.recordAction(item.id, {
                kind: "replied",
                outcome: "dismissed",
                ...(event.text ? { result: event.text.slice(0, MAX_REPLY_CHARS) } : {}),
              });
            } else if (event.at > (item.sourceAt ?? 0)) {
              const snippet = event.text?.trim().slice(0, MAX_SNIPPET_CHARS);
              await deps.items.ingest([
                {
                  loopId: loop.id,
                  dedupeKey: item.sourceKey,
                  ...(item.source !== undefined ? { source: item.source } : {}),
                  ...(snippet ? { summary: snippet } : {}),
                  sourceAt: event.at,
                  sourcePayload: {
                    ...item.sourcePayload,
                    ...(snippet ? { snippet } : {}),
                    receivedAt: event.at,
                  },
                },
              ]);
            }
          } catch (e) {
            swallow("inbox realtime: update item", e);
          }
        }
        if (!ownerReplied && deps.requestFire) {
          const last = lastFireAt.get(loop.id) ?? 0;
          if (Date.now() - last > FIRE_DEBOUNCE_MS) {
            lastFireAt.set(loop.id, Date.now());
            deps.requestFire(loop.id);
          }
        }
      }
    },
  };
}
