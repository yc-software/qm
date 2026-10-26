import type { CronStore } from "../cron/cron-store.ts";
import type { InboxEventSink, InboxLedger } from "./ledger.ts";
import type { ConversationEvent } from "./sources/adapter.ts";
import { sourceAdapter } from "./sources/index.ts";
import { isResolved } from "./view.ts";

export interface InboxRealtimeDeps {
  crons: Pick<CronStore, "list">;
  items: Pick<InboxLedger, "byCron">;
  record: InboxEventSink;
}

const CRON_CACHE_TTL_MS = 60_000;

export function createInboxRealtime(deps: InboxRealtimeDeps): {
  onConversationEvent(event: ConversationEvent): Promise<void>;
} {
  let cachedInboxCrons: Array<{ id: string; owner: string }> = [];
  let cacheAt = 0;

  async function inboxCrons(): Promise<Array<{ id: string; owner: string }>> {
    const now = Date.now();
    if (now - cacheAt > CRON_CACHE_TTL_MS) {
      cachedInboxCrons = (await deps.crons.list())
        .filter((cron) => cron.inbox?.source && !cron.archived)
        .map((cron) => ({ id: cron.id, owner: cron.owner }));
      cacheAt = now;
    }
    return cachedInboxCrons;
  }

  return {
    async onConversationEvent(event) {
      if (!Number.isFinite(event.at)) return;
      const adapter = sourceAdapter(event.source);
      if (!adapter) return;
      for (const cron of await inboxCrons()) {
        const owner = Boolean(event.senderEmail && event.senderEmail.toLowerCase() === cron.owner.toLowerCase());
        const matched = (await deps.items.byCron(cron.id)).filter(
          (item) =>
            (item.source ?? item.sourcePayload?.source) === event.source &&
            adapter.matchesEvent(item, event.conversationRef) &&
            !(owner && isResolved(item)),
        );
        const latest = {
          author: owner ? ("owner" as const) : ("other" as const),
          at: event.at,
          ...(event.text ? { text: event.text } : {}),
          ...(event.senderEmail ? { from: event.senderEmail } : {}),
        };
        for (const item of matched) await deps.record(item, latest);
      }
    },
  };
}
