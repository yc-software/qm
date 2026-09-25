export function retryDelay(priorErrors: number): number {
  const base = Math.min(60_000, 15_000 * 2 ** Math.min(Math.max(0, priorErrors), 2));
  return Math.min(60_000, Math.round(base * (1 + Math.random() * 0.2)));
}
