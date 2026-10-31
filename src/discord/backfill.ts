import { LRUCache } from "lru-cache";
import { DISCORD_MESSAGE_IDS } from "../surfaces/message-ids.ts";
import { swallowAs } from "../util/errors.ts";
import { snowflakeAt } from "../util/snowflake.ts";

const DISCORD_BACKFILL_MAX_AGE_MS = 6 * 3_600_000;
export const DISCORD_BACKFILL_PAGE = 100;
const SEEN_CHANNELS_MAX = 5_000;

export const BACKFILL_GAP_NOTE =
  "Discord messages in this channel arrived while QM was offline or reconnecting and were only partly caught up, so some may be missing from context.";

export interface BackfillChannel<M extends { id: string }> {
  baseChannelId: string;
  lastMessageId: string | null;
  newest(limit: number): Promise<M[]>;
}

export interface Backfill {
  seen(channelId: string, messageId: string): void;
  run(): Promise<void>;
}

const newest = (a: string | undefined, b: string): string =>
  a !== undefined && DISCORD_MESSAGE_IDS.compare(a, b) >= 0 ? a : b;

export function createBackfill<M extends { id: string }>(deps: {
  watermarks(): Promise<Array<{ container: string; lastTs: string }>>;
  open(channelId: string): Promise<BackfillChannel<M> | null>;
  dispatch(message: M): Promise<void>;
  noteGap(baseChannelId: string, note: string): Promise<void>;
  now?: () => number;
}): Backfill {
  const now = deps.now ?? Date.now;
  const seen = new LRUCache<string, string>({ max: SEEN_CHANNELS_MAX });
  let running: Promise<void> | null = null;
  let rerun = false;
  async function sweep(): Promise<void> {
    const floor = snowflakeAt(now() - DISCORD_BACKFILL_MAX_AGE_MS);
    const marks = new Map<string, string>();
    for (const { container, lastTs } of await deps.watermarks()) marks.set(container, lastTs);
    for (const [channelId, messageId] of seen.entries()) marks.set(channelId, messageId);
    for (const [channelId, since] of marks) {
      const after = newest(since, floor);
      try {
        const channel = await deps.open(channelId);
        if (
          !channel ||
          (channel.lastMessageId !== null && DISCORD_MESSAGE_IDS.compare(channel.lastMessageId, after) <= 0)
        )
          continue;
        const page = await channel.newest(DISCORD_BACKFILL_PAGE);
        const fresh = page
          .filter((m) => DISCORD_MESSAGE_IDS.compare(m.id, after) > 0)
          .sort((a, b) => DISCORD_MESSAGE_IDS.compare(a.id, b.id));
        for (const message of fresh) await deps.dispatch(message);
        if (page.length >= DISCORD_BACKFILL_PAGE && fresh.length === page.length)
          await deps.noteGap(channel.baseChannelId, BACKFILL_GAP_NOTE);
      } catch (err) {
        swallowAs(`discord: backfill ${channelId}`, undefined)(err);
      }
    }
  }
  return {
    seen(channelId, messageId) {
      seen.set(channelId, newest(seen.get(channelId), messageId));
    },
    run() {
      if (running) {
        rerun = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            rerun = false;
            await sweep();
          } while (rerun);
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}
