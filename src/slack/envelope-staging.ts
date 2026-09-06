import type { DurableMap } from "../persistence/durable-map.ts";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";

export interface StagedEnvelope {
  body: Record<string, unknown>;
  account: string;
  receivedAt: number;
  attempts: number;
  claimedUntil?: number;
}

interface ReplayGate {
  persisted(): void;
  failed(reason?: string): void;
}

export interface EnvelopeStaging {
  keyFor(body: Record<string, unknown>): string | null;
  stage(key: string, body: Record<string, unknown>): Promise<boolean>;
  accepted(key: string): void;
  sweep(replay: (body: Record<string, unknown>, gate: ReplayGate) => Promise<void>): Promise<number>;
}

const STAGE_TIMEOUT_MS = 300;
const ABANDON_AFTER_MS = 24 * 60 * 60_000;
const STALE_AFTER_MS = 3 * 60_000;
const CLAIM_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const REPLAY_WAIT_MS = 10_000;

export function envelopeKey(account: string, body: Record<string, unknown>): string | null {
  const event = body.event as { type?: string; channel?: string; ts?: string; event_ts?: string } | undefined;
  if (body.type !== "event_callback" || !event?.type || !event.channel) return null;
  const ts = event.ts ?? event.event_ts;
  return ts ? `slack:${account}:${event.type}:${event.channel}:${ts}` : null;
}

export function createEnvelopeStaging(
  map: DurableMap<StagedEnvelope>,
  opts: {
    account: string;
    now?: () => number;
    stageTimeoutMs?: number;
    staleAfterMs?: number;
    maxAttempts?: number;
    replayWaitMs?: number;
  },
): EnvelopeStaging {
  const now = opts.now ?? Date.now;
  const stageTimeoutMs = opts.stageTimeoutMs ?? STAGE_TIMEOUT_MS;
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const replayWaitMs = opts.replayWaitMs ?? REPLAY_WAIT_MS;
  const inflight = new Map<string, Promise<boolean>>();
  const clear = (key: string): void => {
    void (inflight.get(key) ?? Promise.resolve())
      .then(() => map.delete(key))
      .catch(swallowAs("slack: clear staged envelope", undefined));
  };
  return {
    keyFor: (body) => envelopeKey(opts.account, body),
    async stage(key, body) {
      const write = map
        .putIfAbsent(key, { body, account: opts.account, receivedAt: now(), attempts: 0 })
        .then(() => true)
        .catch(swallowAs("slack: stage envelope", false));
      inflight.set(key, write);
      void write.finally(() => {
        if (inflight.get(key) === write) inflight.delete(key);
      });
      return Promise.race([write, sleep(stageTimeoutMs, { unref: true }).then(() => false)]);
    },
    accepted: clear,
    async sweep(replay) {
      const at = now();
      let replayed = 0;
      for (const [key, staged] of await map.entries()) {
        if (staged.receivedAt < at - ABANDON_AFTER_MS) {
          await map.delete(key);
          continue;
        }
        if (staged.account !== opts.account) continue;
        if (staged.receivedAt > at - staleAfterMs || (staged.claimedUntil ?? 0) > at) continue;
        if (staged.attempts >= maxAttempts) continue;
        let won = !map.update;
        const claim = { attempts: staged.attempts + 1, claimedUntil: at + CLAIM_MS };
        const claimed = map.update
          ? await map.update(key, (v) => {
              if ((v.claimedUntil ?? 0) > at) return v;
              won = true;
              return { ...v, ...claim };
            })
          : await map.merge(key, claim);
        if (!claimed || !won) continue;
        if (claimed.attempts >= maxAttempts)
          console.error(
            `[slack-plugin] last replay of staged envelope ${key}; it stays until the daily sweep drops it`,
          );
        replayed++;
        let failed = false;
        const gate: ReplayGate = {
          persisted: () => clear(key),
          failed: () => {
            failed = true;
          },
        };
        const settled = replay(staged.body, gate)
          .then(() => {
            if (!failed) clear(key);
          })
          .catch(swallowAs(`slack: replay staged envelope ${key}`, undefined));
        await Promise.race([settled, sleep(replayWaitMs, { unref: true })]);
      }
      return replayed;
    },
  };
}
