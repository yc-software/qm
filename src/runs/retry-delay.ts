export function retryDelay(priorErrors: number): number {
  const base = Math.min(60_000, 15_000 * 2 ** Math.min(Math.max(0, priorErrors), 2));
  return Math.min(60_000, Math.round(base * (1 + Math.random() * 0.2)));
}

const MAX_PROVIDER_RETRY_DELAY_MS = 10 * 60_000;

export function runRetryDelay(priorErrors: number, providerRetryAfterMs?: number): number {
  const backoff = retryDelay(priorErrors);
  if (providerRetryAfterMs === undefined) return backoff;
  return Math.max(backoff, Math.min(MAX_PROVIDER_RETRY_DELAY_MS, providerRetryAfterMs));
}
