import { LRUCache } from "lru-cache";

export function mentionsBot(text: string, botUserId: string): boolean {
  return botUserId ? text.includes(`<@${botUserId}>`) : false;
}

export function threadHasBotStake(
  messages: readonly { user?: string; bot_id?: string; text?: string }[],
  botUserId: string,
  ownBotId = "",
): boolean {
  if (!botUserId && !ownBotId) return false;
  return messages.some((m) => {
    const user = m.user ? String(m.user) : "";
    const bot = m.bot_id ? String(m.bot_id) : "";
    const text = m.text ? String(m.text) : "";
    return Boolean(
      (botUserId && user === botUserId) ||
      (ownBotId && bot === ownBotId) ||
      (botUserId && mentionsBot(text, botUserId)),
    );
  });
}

export function shouldProcessMessage(
  m: { subtype?: string; bot_id?: string; user?: string },
  botUserId: string,
  ownBotId = "",
): boolean {
  if (botUserId && m.user === botUserId) return false;
  if (ownBotId && m.bot_id === ownBotId) return false;
  if (m.subtype && m.subtype !== "file_share" && m.subtype !== "thread_broadcast" && m.subtype !== "bot_message")
    return false;
  return true;
}

export function isGroupMembershipMessage(m: { channel_type?: string; subtype?: string }): boolean {
  return m.channel_type === "mpim" && (m.subtype === "group_join" || m.subtype === "group_leave");
}

export function channelPrivacyChange(m: {
  channel?: string;
  subtype?: string;
}): { channel: string; isPrivate: boolean } | null {
  if (!m.channel) return null;
  if (m.subtype === "channel_convert_to_private") return { channel: m.channel, isPrivate: true };
  if (m.subtype === "channel_convert_to_public") return { channel: m.channel, isPrivate: false };
  return null;
}

export function createRefreshCoalescer(run: () => Promise<void>): () => Promise<void> {
  let requested = 0;
  let active: Promise<void> | undefined;
  return function refresh(): Promise<void> {
    requested++;
    if (!active) {
      active = (async function drain(): Promise<void> {
        let completed: number;
        try {
          do {
            completed = requested;
            await run();
          } while (completed !== requested);
        } finally {
          active = undefined;
        }
        if (completed !== requested) return refresh();
      })();
    }
    return active;
  };
}

export function hasContent(text: string, files: readonly unknown[]): boolean {
  return text.trim().length > 0 || files.length > 0;
}

export function isThreadReply(m: { thread_ts?: string; ts?: string }): boolean {
  return Boolean(m.thread_ts) && m.thread_ts !== m.ts;
}

export interface ThreadTracker {
  get(channel: string, threadTs: string): boolean | undefined;
  mark(channel: string, threadTs: string, present: boolean): void;
}

const THREAD_NO_STAKE_TTL_MS = 5 * 60_000;

export function createThreadTracker(opts: { negativeTtlMs?: number } = {}): ThreadTracker {
  const negativeTtlMs = opts.negativeTtlMs ?? THREAD_NO_STAKE_TTL_MS;
  const cache = new LRUCache<string, boolean>({ max: 10_000 });
  const keyOf = (channel: string, threadTs: string): string => `${channel}:${threadTs}`;
  return {
    get(channel, threadTs) {
      return cache.get(keyOf(channel, threadTs));
    },
    mark(channel, threadTs, present) {
      cache.set(keyOf(channel, threadTs), present, present ? undefined : { ttl: negativeTtlMs });
    },
  };
}

export function dmThreadRef(channel: string, threadTs?: string): string {
  return threadTs ? `dm:${channel}:${threadTs}` : `dm:${channel}`;
}

export function dedupeKey(e: { event_id?: string; client_msg_id?: string; channel?: string; ts?: string }): string {
  if (e.channel && e.ts) return `${e.channel}:${e.ts}`;
  return e.event_id || e.client_msg_id || `${e.channel ?? ""}:${e.ts ?? ""}`;
}

export function createDeduper(max = 500): { seen(key: string): boolean; forget(key: string): void } {
  const cache = new LRUCache<string, true>({ max });
  return {
    seen(key: string): boolean {
      if (cache.has(key)) return true;
      cache.set(key, true);
      return false;
    },
    forget(key: string): void {
      cache.delete(key);
    },
  };
}

export async function dedupedRun(
  deduper: { seen(key: string): boolean; forget(key: string): void },
  key: string,
  run: () => Promise<void>,
  onError: (err: unknown) => void,
): Promise<void> {
  if (deduper.seen(key)) return;
  try {
    await run();
  } catch (err) {
    deduper.forget(key);
    onError(err);
  }
}

export function isBareStop(text: string): boolean {
  return /^stop[.!]?$/i.test(text.trim());
}

export function createInFlightThreadMap(): {
  set(threadRef: string, runId: string): void;
  get(threadRef: string): string | undefined;
  clear(threadRef: string, runId: string): void;
} {
  const byThread = new Map<string, string>();
  return {
    set: (threadRef, runId) => byThread.set(threadRef, runId),
    get: (threadRef) => byThread.get(threadRef),
    clear: (threadRef, runId) => {
      if (byThread.get(threadRef) === runId) byThread.delete(threadRef);
    },
  };
}

export async function maybeInterceptStop(opts: {
  text: string;
  threadRef: string;
  getInFlightRun: (threadRef: string) => string | undefined | Promise<string | undefined>;
  signalAbort: (runId: string) => Promise<void>;
}): Promise<boolean> {
  if (!isBareStop(opts.text)) return false;
  const runId = await opts.getInFlightRun(opts.threadRef);
  if (!runId) return false;
  await opts.signalAbort(runId);
  return true;
}
