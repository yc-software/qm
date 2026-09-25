import { randomUUID } from "node:crypto";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { ClientToolResult, TurnRequest } from "../types.ts";
import { swallowAs } from "../util/errors.ts";

export type RunSignalKind = "abort" | "steer" | "client_result";

export interface RunSignal {
  kind: RunSignalKind;
  text?: string;
  ts?: string;
  request?: TurnRequest;
  dedupeKey?: string;
  sessionRequest?: OrchestratorInput;
  queuedRunId?: string;
  callId?: string;
  result?: ClientToolResult;
}

export interface RunSignalStore {
  send(runId: string, signal: RunSignal): Promise<boolean>;
  hasDedupeKey(dedupeKey: string): Promise<boolean>;
  pending(runId: string): Promise<Array<{ id: string; signal: RunSignal }>>;
  acknowledge(runId: string, id: string): Promise<void>;
  takePending(runId: string): Promise<RunSignal[]>;
  steerAuthors(runId: string): Promise<string[]>;
  pendingRunIds(): Promise<string[]>;
  prune(olderThanMs: number): Promise<void>;
  onSignal(runId: string, cb: () => void): () => void;
  close?(): Promise<void>;
}

const MAX_MEMORY_DEDUPE_KEYS = 10_000;

export function createMemoryRunSignalStore(): RunSignalStore {
  const pending = new Map<string, RunSignal[]>();
  const receipts = new WeakMap<RunSignal, string>();
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
      signal = { ...signal };
      receipts.set(signal, randomUUID());
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
    async pending(runId) {
      return (pending.get(runId) ?? []).map((signal) => ({ id: receipts.get(signal)!, signal }));
    },
    async acknowledge(runId, id) {
      const remaining = (pending.get(runId) ?? []).filter((signal) => receipts.get(signal) !== id);
      if (remaining.length) pending.set(runId, remaining);
      else pending.delete(runId);
    },
    async takePending(runId) {
      const list = pending.get(runId) ?? [];
      pending.delete(runId);
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

export function waitForClientResult(
  signals: RunSignalStore,
  runId: string,
  callId: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<ClientToolResult | "timeout" | "cancelled"> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    let recheck = false;
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      opts.signal?.removeEventListener("abort", onAbort);
      return true;
    };
    const finish = (outcome: ClientToolResult | "timeout" | "cancelled" | Error): void => {
      if (!claim()) return;
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const onAbort = (): void => finish("cancelled");
    const check = async (): Promise<void> => {
      if (settled) return;
      if (checking) {
        recheck = true;
        return;
      }
      checking = true;
      try {
        do {
          recheck = false;
          const match = (await signals.pending(runId)).find(
            ({ signal }) => signal.kind === "client_result" && signal.callId === callId && signal.result,
          );
          if (match && claim()) {
            await signals.acknowledge(runId, match.id).catch(swallowAs("client result acknowledge", undefined));
            resolve(match.signal.result!);
          }
        } while (recheck && !settled);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      } finally {
        checking = false;
      }
    };
    const timer = setTimeout(() => finish("timeout"), opts.timeoutMs);
    const unsubscribe = signals.onSignal(runId, () => void check());
    if (opts.signal?.aborted) return finish("cancelled");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    void check();
  });
}

const SIGNAL_POLL_MS = 5_000;

export interface SignalPollHandlers {
  onSteer(text: string, ts?: string, request?: TurnRequest): Promise<void | boolean>;
  onAbort(): Promise<void>;
}

export function startSignalPoll(
  signals: RunSignalStore,
  runId: string,
  handlers: SignalPollHandlers,
  opts?: { intervalMs?: number; onError?: (e: unknown) => void; drainOnStop?: boolean },
): () => Promise<void> {
  const declined = new Set<string>();
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
      for (const { id, signal: s } of await signals.pending(runId)) {
        if (s.kind === "client_result") continue;
        try {
          if (s.kind === "abort") {
            if (!abortDelivered) {
              await handlers.onAbort();
              abortDelivered = true;
            }
          } else if (!declined.has(id)) {
            if (s.text || s.request?.attachments?.length) {
              const delivered = await handlers.onSteer(s.text ?? "", s.ts, s.request);
              if (delivered === false) {
                declined.add(id);
                continue;
              }
            }
            await signals.acknowledge(runId, id);
          }
        } catch (e) {
          opts?.onError?.(e);
        }
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
