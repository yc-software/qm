import type { Delivery } from "../types.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { reportFailure } from "../util/errors.ts";

const CLAIM_MARGIN_MS = 2_000;
const FOLLOWER_RETRY_MS = 5_000;
const RETRY_MS = 5_000;

export async function drainClaimedDeliveries(opts: {
  claim: (type: string, claimMs: number) => Promise<Delivery[]>;
  claimMs: number;
  types: string[];
  deliver: (d: Delivery) => Promise<void>;
  label: string;
  leaseLost?: () => boolean;
}): Promise<number> {
  const { claimMs, types, deliver, label, leaseLost } = opts;
  const claimMargin = Math.min(CLAIM_MARGIN_MS, Math.floor(claimMs / 3));
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const expiresAt = new Map<string, number>();

  const claim = async (): Promise<{ rows: Delivery[]; complete: boolean }> => {
    const rows: Delivery[] = [];
    let complete = true;
    for (const t of types) {
      try {
        const claimed = await opts.claim(t, claimMs);
        const at = Date.now();
        for (const r of claimed) expiresAt.set(r.id, at + claimMs);
        rows.push(...claimed);
      } catch {
        complete = false;
      }
    }
    return { rows, complete };
  };
  const t0 = Date.now();
  const queue = (await claim()).rows;
  const seen = new Set(queue.map((d) => d.id));
  const absorb = (fresh: Delivery[]): void => {
    for (const f of fresh) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        queue.push(f);
      }
    }
  };

  const reclaimOwnership = async (id: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (leaseLost?.()) return false;
      if (attempt > 0) await sleep(Math.min(300, claimMargin));
      const { rows, complete } = await claim();
      absorb(rows);
      if (rows.some((f) => f.id === id)) return true;
      if (!complete) continue;
    }
    return false;
  };
  for (let i = 0; i < queue.length; i++) {
    if (leaseLost?.()) {
      console.error(`[${label}] delivery dispatch lease lost mid-drain — stopping; rows recover after claim TTL`);
      return queue.length;
    }
    const d = queue[i]!;
    const exp = expiresAt.get(d.id) ?? 0;
    if (Date.now() >= exp - claimMargin) {
      const remaining = exp - Date.now();
      if (remaining > 0) await sleep(remaining);
      if (!(await reclaimOwnership(d.id))) {
        seen.delete(d.id);
        console.log(
          `[${label}] delivery ${d.id} claim lost after ${Date.now() - t0}ms (another relay owns it, or it was acked) — skipping`,
        );
        continue;
      }
    }
    if (leaseLost?.()) {
      console.error(`[${label}] delivery dispatch lease lost mid-drain — stopping; rows recover after claim TTL`);
      return queue.length;
    }
    await deliver(d);
  }
  return queue.length;
}

export function startRelayLoop(opts: {
  drain: () => Promise<boolean>;
  onEnqueued: (listener: () => void) => () => void;
  sweepMs: number;
  label: string;
}): { stop(): void } {
  let stopped = false;
  let inFlight = false;
  let again = false;
  let followerRetry: ReturnType<typeof setTimeout> | undefined;
  const wake = (): void => {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    void opts
      .drain()
      .then((ranAsLeader) => {
        if (!ranAsLeader && !stopped && !followerRetry) {
          followerRetry = setTimeout(() => {
            followerRetry = undefined;
            wake();
          }, FOLLOWER_RETRY_MS);
          followerRetry.unref?.();
        }
      })
      .catch((error) => reportFailure(`${opts.label}: delivery drain`, error))
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          wake();
        }
      });
  };
  const unsubscribe = opts.onEnqueued(wake);
  const timer = setInterval(wake, opts.sweepMs);
  timer.unref?.();
  wake();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (followerRetry) clearTimeout(followerRetry);
      unsubscribe();
    },
  };
}

export interface OutboundChannel {
  type: string;
  send(d: Delivery): Promise<{ refused: string } | void>;
}

export function startOutboundRelay(
  channel: OutboundChannel,
  deps: {
    claim: (type: string, claimMs: number) => Promise<Delivery[]>;
    ack: (id: string) => Promise<void>;
    fail: (id: string, reason: string) => Promise<unknown>;
    lease: LeaderLease;
    onEnqueued: (listener: () => void) => () => void;
    retryMs?: number;
  },
): { stop(): void } {
  const label = `${channel.type}-relay`;
  let stopped = false;
  let leaseLost = (): boolean => false;
  const deliver = async (d: Delivery): Promise<void> => {
    let outcome: { refused: string } | void;
    for (;;) {
      try {
        outcome = await channel.send(d);
        break;
      } catch (error) {
        if (stopped || leaseLost()) throw error;
        reportFailure(`${label}: delivery ${d.id} not accepted yet; retrying in order`, error);
        await new Promise((r) => setTimeout(r, deps.retryMs ?? RETRY_MS));
      }
    }
    if (outcome) {
      console.error(`[${label}] delivery ${d.id} refused permanently (${outcome.refused}) — failing it, no retry`);
      await deps.fail(d.id, outcome.refused);
    } else await deps.ack(d.id);
  };
  const loop = startRelayLoop({
    label,
    sweepMs: 60_000,
    onEnqueued: deps.onEnqueued,
    drain: async () => {
      const held = await deps.lease.hold(`${channel.type}:delivery-dispatch`, async (lost) => {
        let lostFlag = false;
        void lost.then(() => {
          lostFlag = true;
        });
        leaseLost = () => lostFlag;
        await drainClaimedDeliveries({
          claim: deps.claim,
          claimMs: 30_000,
          types: [channel.type],
          deliver,
          label,
          leaseLost,
        });
        return true;
      });
      return held === true;
    },
  });
  return {
    stop() {
      stopped = true;
      loop.stop();
    },
  };
}
