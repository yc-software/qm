import { AsyncLocalStorage } from "node:async_hooks";
import { LRUCache } from "lru-cache";
import { swallow } from "../util/errors.ts";
import { slackHistoryRateLimitMessage } from "./history-rate-limit.ts";
import { parseDeliveryTarget } from "./lib.ts";

interface Recipient {
  target: string;
  user: string;
}

export function createSlackRateLimitNotice(opts: { managed?: boolean; setupUrl?: string; client?: any }) {
  const recentlyNotified = new LRUCache<string, true>({ max: 1000, ttl: 60_000, ttlResolution: 0 });
  const active = new AsyncLocalStorage<{ client: any; recipient: Recipient; sent: boolean } | undefined>();
  return {
    run<T>(client: any, recipient: Recipient | undefined, fn: () => Promise<T>): Promise<T> {
      return active.run(recipient ? { client, recipient, sent: false } : undefined, fn);
    },
    async observe(error: unknown): Promise<void> {
      const request = active.getStore();
      if (!request || request.sent || !opts.managed) return;
      const text = slackHistoryRateLimitMessage(error, { ...opts, format: "slack" });
      if (!text) return;
      request.sent = true;
      try {
        const client = opts.client ?? request.client;
        const { channel, threadTs } = parseDeliveryTarget(request.recipient.target);
        if (!/^[CDG][A-Z0-9]+$/.test(channel)) return;
        const user = /^[UW][A-Z0-9]+$/.test(request.recipient.user)
          ? request.recipient.user
          : (await client.users.lookupByEmail({ email: request.recipient.user })).user?.id;
        if (!user) return;
        const key = `${channel}:${user}`;
        if (recentlyNotified.has(key)) return;
        recentlyNotified.set(key, true);
        if (channel.startsWith("D")) {
          await client.chat.postMessage({
            channel,
            text,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            unfurl_links: false,
            unfurl_media: false,
          });
        } else {
          await client.chat.postEphemeral({ channel, user, text });
        }
      } catch (error) {
        swallow("slack: rate-limit notice", error);
      }
    },
  };
}

export type SlackRateLimitNotice = ReturnType<typeof createSlackRateLimitNotice>;
