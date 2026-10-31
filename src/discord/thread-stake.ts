import { LRUCache } from "lru-cache";
import { swallowAs } from "../util/errors.ts";

export interface StakeMessage {
  authorId: string;
  mentionedUserIds: readonly string[];
}

export const THREAD_NO_STAKE_TTL_MS = 5 * 60_000;
export const THREAD_STAKES_MAX = 5_000;

export function hasBotStake(messages: readonly StakeMessage[], botUserId: string): boolean {
  return messages.some((m) => m.authorId === botUserId || m.mentionedUserIds.includes(botUserId));
}

export interface StakeTracker {
  has(threadId: string, botUserId: string): Promise<boolean>;
  mark(threadId: string): void;
}

export function createStakeTracker(opts: {
  recent(threadId: string): Promise<StakeMessage[]>;
  now?: () => number;
}): StakeTracker {
  const now = opts.now ?? Date.now;
  const staked = new LRUCache<string, true>({ max: THREAD_STAKES_MAX });
  const noStakeAt = new LRUCache<string, number>({ max: THREAD_STAKES_MAX });
  const inFlight = new Map<string, Promise<boolean>>();
  async function lookup(threadId: string, botUserId: string): Promise<boolean> {
    let recent: StakeMessage[];
    try {
      recent = await opts.recent(threadId);
    } catch (err) {
      swallowAs("discord: thread stake", undefined)(err);
      return false;
    }
    if (hasBotStake(recent, botUserId)) {
      staked.set(threadId, true);
      return true;
    }
    noStakeAt.set(threadId, now());
    return false;
  }
  return {
    async has(threadId, botUserId) {
      if (staked.has(threadId)) return true;
      const checked = noStakeAt.get(threadId);
      if (checked !== undefined && now() - checked <= THREAD_NO_STAKE_TTL_MS) return false;
      const pending = inFlight.get(threadId) ?? lookup(threadId, botUserId).finally(() => inFlight.delete(threadId));
      inFlight.set(threadId, pending);
      return pending;
    },
    mark(threadId) {
      staked.set(threadId, true);
      noStakeAt.delete(threadId);
    },
  };
}
