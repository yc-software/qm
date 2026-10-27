import type { CronStore } from "../cron/cron-store.ts";
import { perTenant } from "../tenant.ts";
import type { InboxEventSink, InboxLedger } from "./ledger.ts";
import type { ConversationEvent } from "./sources/adapter.ts";
import { sourceAdapter } from "./sources/index.ts";
import { isResolved } from "./view.ts";

export interface InboxRealtimeDeps {
  crons: Pick<CronStore, "list">;
  items: Pick<InboxLedger, "byConversation">;
  record: InboxEventSink;
}

const CRON_CACHE_TTL_MS = 60_000;

export function createInboxRealtime(deps: InboxRealtimeDeps): {
  onConversationEvent(event: ConversationEvent): Promise<void>;
} {
  const cache = perTenant(() => ({ crons: [] as Array<{ id: string; owner: string }>, at: 0 }));

  async function inboxCrons(): Promise<Array<{ id: string; owner: string }>> {
    const own = cache();
    const now = Date.now();
    if (now - own.at > CRON_CACHE_TTL_MS) {
      own.crons = (await deps.crons.list())
        .filter((cron) => cron.inbox?.source && !cron.archived)
        .map((cron) => ({ id: cron.id, owner: cron.owner }));
      own.at = now;
    }
    return own.crons;
  }

  return {
    async onConversationEvent(event) {
      if (!Number.isFinite(event.at)) return;
      const adapter = sourceAdapter(event.source);
      if (!adapter) return;
      const items = await deps.items.byConversation(event.conversationKey);
      if (!items.length) return;
      const crons = await inboxCrons();
      for (const cron of crons) {
        const owner = Boolean(event.senderEmail && event.senderEmail.toLowerCase() === cron.owner.toLowerCase());
        const matched = items.filter(
          (item) =>
            item.cronId === cron.id &&
            item.source === event.source &&
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
