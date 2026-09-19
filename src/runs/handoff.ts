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
        retiring.timer = setTimeout(() => retiring.deadline.abort(), delay);
        retiring.timer.unref?.();
      }
      retiring.requested.abort();
      if (delay === 0) retiring.deadline.abort();
    },
    reset(): void {
      current = generation();
    },
  };
}

export type Handoff = ReturnType<typeof createHandoff>;
