import type { ScopeActivity, SessionStore } from "../../../sessions/session-store.ts";
import { reportFailure } from "../../../util/errors.ts";

const REFRESH_MS = 5 * 60_000;

export interface ScopeActivitySnapshot {
  asOf: number;
  byScope: Map<string, ScopeActivity>;
}

const snapshots = new WeakMap<SessionStore, { snapshot?: ScopeActivitySnapshot; refreshing?: Promise<void> }>();

export function scopeActivity(store: SessionStore | undefined): ScopeActivitySnapshot | null {
  if (!store) return null;
  let entry = snapshots.get(store);
  if (!entry) snapshots.set(store, (entry = {}));
  const state = entry;
  if (!state.refreshing && (!state.snapshot || Date.now() - state.snapshot.asOf > REFRESH_MS)) {
    state.refreshing = store
      .scopeActivity()
      .then((rows) => {
        state.snapshot = { asOf: Date.now(), byScope: new Map(rows.map((r) => [r.scopeId, r])) };
      })
      .catch((error: unknown) => reportFailure("admin: scope activity refresh", error))
      .finally(() => {
        state.refreshing = undefined;
      });
  }
  return state.snapshot ?? null;
}

export function activityCounts(
  snapshot: ScopeActivitySnapshot,
  scope: string,
  orgWide: boolean,
): { conversation: number; cron: number; background: number } {
  const rows = orgWide ? [...snapshot.byScope.values()] : [snapshot.byScope.get(scope)].filter((r) => !!r);
  const counts = { conversation: 0, cron: 0, background: 0 };
  for (const r of rows) {
    counts.conversation += r.conversations;
    counts.cron += r.crons;
    counts.background += r.background;
  }
  return counts;
}
