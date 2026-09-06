import type { TurnRequest } from "../types.ts";

export type RunSignalKind = "abort" | "steer";

export interface RunSignal {
  kind: RunSignalKind;
  text?: string;
  ts?: string;
  request?: TurnRequest;
  dedupeKey?: string;
}

export interface RunSignalStore {
  send(runId: string, signal: RunSignal): Promise<boolean>;
  hasDedupeKey(dedupeKey: string): Promise<boolean>;
  takePending(runId: string): Promise<RunSignal[]>;
  takeLive(runId: string): Promise<RunSignal[]>;
  steerAuthors(runId: string): Promise<string[]>;
  pendingRunIds(): Promise<string[]>;
  prune(olderThanMs: number): Promise<void>;
  onSignal(runId: string, cb: () => void): () => void;
  close?(): Promise<void>;
}

const MAX_MEMORY_DEDUPE_KEYS = 10_000;

export function createMemoryRunSignalStore(): RunSignalStore {
  const pending = new Map<string, RunSignal[]>();
  const authors = new Map<string, Array<{ at: number; author: string }>>();
  const listeners = new Map<string, Set<() => void>>();
  const dedupeKeys = new Set<string>();
  return {
    async send(runId, signal) {
      if (signal.dedupeKey) {
        if (dedupeKeys.has(signal.dedupeKey)) return false;
        dedupeKeys.add(signal.dedupeKey);
        if (dedupeKeys.size > MAX_MEMORY_DEDUPE_KEYS) dedupeKeys.delete(dedupeKeys.values().next().value!);
      }
      const list = pending.get(runId) ?? [];
      list.push(signal);
      pending.set(runId, list);
      const author = signal.kind === "steer" ? signal.request?.actor?.externalId : undefined;
      if (author) authors.set(runId, [...(authors.get(runId) ?? []), { at: Date.now(), author }]);
      for (const cb of listeners.get(runId) ?? []) cb();
      return true;
    },
    async hasDedupeKey(dedupeKey) {
      return dedupeKeys.has(dedupeKey);
    },
    async steerAuthors(runId) {
      return [...new Set((authors.get(runId) ?? []).map((a) => a.author))];
    },
    async takePending(runId) {
      const list = pending.get(runId) ?? [];
      pending.delete(runId);
      return list;
    },
    async takeLive(runId) {
      const list = pending.get(runId) ?? [];
      const aborts = list.filter((s) => s.kind === "abort");
      if (aborts.length) pending.set(runId, aborts);
      else pending.delete(runId);
      return list;
    },
    async pendingRunIds() {
      return [...pending.keys()];
    },
    async prune(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      for (const [runId, list] of authors) {
        const kept = list.filter((a) => a.at >= cutoff);
        if (kept.length) authors.set(runId, kept);
        else authors.delete(runId);
      }
    },
    onSignal(runId, cb) {
      const set = listeners.get(runId) ?? new Set();
      set.add(cb);
      listeners.set(runId, set);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(runId);
      };
    },
  };
}

const SIGNAL_POLL_MS = 5_000;

export interface SignalPollHandlers {
  onSteer(text: string, ts?: string): Promise<void>;
  onAbort(): Promise<void>;
}

export function startSignalPoll(
  signals: RunSignalStore,
  runId: string,
  handlers: SignalPollHandlers,
  opts?: { intervalMs?: number; onError?: (e: unknown) => void; drainOnStop?: boolean },
): () => Promise<void> {
  let draining = false;
  let redrain = false;
  let accepting = true;
  let inFlight: Promise<void> = Promise.resolve();
  const drain = (forced = false): void => {
    if (!accepting && !forced) return;
    if (draining) {
      redrain = true;
      return;
    }
    draining = true;
    inFlight = (async () => {
      let abortDelivered = false;
      for (const s of await signals.takeLive(runId)) {
        if (s.kind === "abort") {
          if (!abortDelivered) {
            await handlers.onAbort();
            abortDelivered = true;
          }
        } else if (s.text) await handlers.onSteer(s.text, s.ts);
      }
    })()
      .catch((e: unknown) => opts?.onError?.(e))
      .finally(() => {
        draining = false;
        if (redrain) {
          redrain = false;
          drain();
        }
      });
  };
  const unsubscribe = signals.onSignal(runId, drain);
  const timer = setInterval(drain, opts?.intervalMs ?? SIGNAL_POLL_MS);
  timer.unref?.();
  return async () => {
    accepting = false;
    clearInterval(timer);
    unsubscribe();
    if (opts?.drainOnStop) drain(true);
    for (;;) {
      const current = inFlight;
      await current;
      if (!draining && inFlight === current) break;
    }
  };
}
