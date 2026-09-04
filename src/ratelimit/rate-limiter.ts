interface RateDecision {
  allowed: boolean;
  retryAfterMs?: number;
}

export interface RateLimiter {
  check(principalId: string): Promise<RateDecision>;
}

export interface RateLimiterOptions {
  maxPerWindow: number;
  windowMs: number;
  now?: () => number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const now = opts.now ?? (() => Date.now());
  const state = new Map<string, { windowStart: number; count: number }>();
  return {
    async check(principalId) {
      const t = now();
      const s = state.get(principalId);
      if (!s || t - s.windowStart >= opts.windowMs) {
        state.set(principalId, { windowStart: t, count: 1 });
        return { allowed: true };
      }
      if (s.count >= opts.maxPerWindow) {
        return { allowed: false, retryAfterMs: opts.windowMs - (t - s.windowStart) };
      }
      s.count++;
      return { allowed: true };
    },
  };
}
