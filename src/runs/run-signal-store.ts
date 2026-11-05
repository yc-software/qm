import type { ClientToolResult, StopScope, TurnRequest } from "../types.ts";
import { swallowAs } from "../util/errors.ts";

export type RunSignalKind = "abort" | "steer" | "client_result";

export interface RunSignal {
  kind: RunSignalKind;
  text?: string;
  ts?: string;
  request?: TurnRequest;
  dedupeKey?: string;
  queuedRunId?: string;
  callId?: string;
  result?: ClientToolResult;
  reason?: string;
  scope?: StopScope;
}

export interface RunSignalStore {
  send(runId: string, signal: RunSignal): Promise<boolean>;
  runForDedupeKey(dedupeKey: string): Promise<string | undefined>;
  pending(runId: string): Promise<Array<{ id: string; signal: RunSignal }>>;
  acknowledge(runId: string, id: string): Promise<void>;
  takePending(runId: string): Promise<RunSignal[]>;
  steerAuthors(runId: string): Promise<string[]>;
  pendingRunIds(): Promise<string[]>;
  prune(olderThanMs: number): Promise<void>;
  onSignal(runId: string, cb: () => void): () => void;
  close?(): Promise<void>;
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
  onSteer(text: string, ts?: string, request?: TurnRequest, acknowledge?: () => Promise<void>): Promise<void | boolean>;
  onAbort(stop: RunSignal): Promise<void>;
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
  let stopDelivered = false;
  let stopCheck: Promise<void> = Promise.resolve();
  const deliverStop = (known?: Awaited<ReturnType<RunSignalStore["pending"]>>): Promise<void> => {
    const check = async (): Promise<void> => {
      if (stopDelivered) return;
      const stop = (known ?? (await signals.pending(runId))).find(({ signal }) => signal.kind === "abort");
      if (stop?.signal.kind !== "abort") return;
      await handlers.onAbort(stop.signal);
      stopDelivered = true;
    };
    return (stopCheck = stopCheck.then(check, check));
  };
  const drain = (forced = false): void => {
    if (!accepting && !forced) return;
    if (draining) {
      redrain = true;
      void deliverStop().catch((e: unknown) => opts?.onError?.(e));
      return;
    }
    draining = true;
    stopDelivered = false;
    inFlight = (async () => {
      const pending = await signals.pending(runId);
      await deliverStop(pending).catch((e: unknown) => opts?.onError?.(e));
      let tookOne = false;
      for (const { id, signal: s } of pending) {
        if (s.kind === "abort" || s.kind === "client_result" || declined.has(id)) continue;
        try {
          if (tookOne) await deliverStop();
          tookOne = true;
          if (s.text || s.request?.attachments?.length) {
            const delivered = await handlers.onSteer(s.text ?? "", s.ts, s.request, () =>
              signals.acknowledge(runId, id),
            );
            if (delivered === false) {
              declined.add(id);
              continue;
            }
          }
          await signals.acknowledge(runId, id);
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
