export function retryDelay(priorErrors: number): number {
  const base = Math.min(60_000, 15_000 * 2 ** Math.min(Math.max(0, priorErrors), 2));
  return Math.min(60_000, Math.round(base * (1 + Math.random() * 0.2)));
}

/** Upper bound on a provider-requested wait, so a bogus header can't park a run for hours. */
export const MAX_PROVIDER_RETRY_AFTER_MS = 10 * 60_000;

/** Backoff for a failed run: never sooner than the provider asked, never later than the cap. */
export function runRetryDelay(priorErrors: number, err: unknown): number {
  const backoff = retryDelay(priorErrors);
  const hinted = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  if (typeof hinted !== "number" || !Number.isFinite(hinted) || hinted <= 0) return backoff;
  return Math.max(backoff, Math.min(hinted, MAX_PROVIDER_RETRY_AFTER_MS));
}
