export type TurnAbortReason = "user" | "shutdown" | "lease-lost";

export function turnAbortReason(signal?: AbortSignal): TurnAbortReason | undefined {
  if (!signal?.aborted) return undefined;
  return signal.reason === "user" || signal.reason === "lease-lost" ? signal.reason : "shutdown";
}

export function isUserStop(signal?: AbortSignal): boolean {
  return turnAbortReason(signal) === "user";
}

export interface HandoffSignals {
  requested: AbortSignal;
  deadline: AbortSignal;
}

function generation() {
  return {
    requested: new AbortController(),
    deadline: new AbortController(),
    expiresAt: Infinity,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
}

export function createHandoff() {
  let current = generation();
  return {
    signals: (): HandoffSignals => ({ requested: current.requested.signal, deadline: current.deadline.signal }),
    request(graceMs: number): void {
      const retiring = current;
      const delay = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 0;
      const expiresAt = Date.now() + delay;
      if (expiresAt >= retiring.expiresAt) return;
      retiring.expiresAt = expiresAt;
      clearTimeout(retiring.timer);
      if (delay > 0) {
        retiring.timer = setTimeout(() => retiring.deadline.abort("shutdown"), delay);
        retiring.timer.unref?.();
      }
      retiring.requested.abort("shutdown");
      if (delay === 0) retiring.deadline.abort("shutdown");
    },
    reset(): void {
      current = generation();
    },
  };
}

export type Handoff = ReturnType<typeof createHandoff>;
