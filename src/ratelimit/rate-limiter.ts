interface RateDecision {
  allowed: boolean;
  retryAfterMs?: number;
}

export interface RateLimiter {
  check(principalId: string): Promise<RateDecision>;
}
