export const ACTIVITY_TOUCH_INTERVAL_MS = 10 * 60_000;
export const ACTIVITY_GRACE_MS = 2 * ACTIVITY_TOUCH_INTERVAL_MS;

export function usedWithinGrace(lastActivityMs: number | undefined, now: number): boolean {
  return (lastActivityMs ?? 0) > now - ACTIVITY_GRACE_MS;
}
