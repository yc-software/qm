import type { DueEnvelope } from "./slack-tables.ts";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";

export interface StagedEnvelope {
  body: Record<string, unknown>;
  account: string;
  receivedAt: number;
  attempts: number;
}

export interface StagedEnvelopeRows {
  putIfAbsent(key: string, row: StagedEnvelope): Promise<unknown>;
  delete(key: string): Promise<void>;
}

interface ReplayGate {
  persisted(): void;
  failed(reason?: string): void;
}

export interface EnvelopeStaging {
  keyFor(body: Record<string, unknown>): string | null;
  stage(key: string, body: Record<string, unknown>): Promise<boolean>;
  accepted(key: string): void;
  replay(due: DueEnvelope, replay: (body: Record<string, unknown>, gate: ReplayGate) => Promise<void>): Promise<void>;
}

const STAGE_TIMEOUT_MS = 300;
export const ENVELOPE_REPLAY = {
  abandonAfterMs: 24 * 60 * 60_000,
  staleAfterMs: 3 * 60_000,
  claimMs: 5 * 60_000,
  maxAttempts: 5,
} as const;
const REPLAY_WAIT_MS = 10_000;

export function envelopeKey(account: string, body: Record<string, unknown>): string | null {
  const event = body.event as { type?: string; channel?: string; ts?: string; event_ts?: string } | undefined;
  if (body.type !== "event_callback" || !event?.type || !event.channel) return null;
  const ts = event.ts ?? event.event_ts;
  return ts ? `slack:${account}:${event.type}:${event.channel}:${ts}` : null;
}

export function createEnvelopeStaging(
  rows: StagedEnvelopeRows,
  opts: {
    account: string;
    now?: () => number;
    stageTimeoutMs?: number;
    maxAttempts?: number;
    replayWaitMs?: number;
  },
): EnvelopeStaging {
  const now = opts.now ?? Date.now;
  const stageTimeoutMs = opts.stageTimeoutMs ?? STAGE_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? ENVELOPE_REPLAY.maxAttempts;
  const replayWaitMs = opts.replayWaitMs ?? REPLAY_WAIT_MS;
  const inflight = new Map<string, Promise<boolean>>();
  const clear = (key: string): void => {
    void (inflight.get(key) ?? Promise.resolve())
      .then(() => rows.delete(key))
      .catch(swallowAs("slack: clear staged envelope", undefined));
  };
  return {
    keyFor: (body) => envelopeKey(opts.account, body),
    async stage(key, body) {
      const write = rows
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
    async replay(due, replay) {
      if (due.attempts >= maxAttempts)
        console.error(
          `[slack-plugin] last replay of staged envelope ${due.key}; it stays until the daily sweep drops it`,
        );
      let failed = false;
      const gate: ReplayGate = {
        persisted: () => clear(due.key),
        failed: () => {
          failed = true;
        },
      };
      const settled = replay(due.body, gate)
        .then(() => {
          if (!failed) clear(due.key);
        })
        .catch(swallowAs(`slack: replay staged envelope ${due.key}`, undefined));
      await Promise.race([settled, sleep(replayWaitMs, { unref: true })]);
    },
  };
}
