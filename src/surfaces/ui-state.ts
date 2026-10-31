import type { DurableMap } from "../persistence/durable-map.ts";

export interface PersistedUiState {
  value: unknown;
  updatedAt: number;
}

export type UiStateStore = DurableMap<PersistedUiState>;

export const UI_STATE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UI_STATE_MAX_BYTES = 65536;
export const UI_STATE_MAX_FUTURE_SKEW_MS = 300_000;

export function uiStateId(principalId: string, key: string): string {
  return `${principalId}#${key}`;
}

export async function storeUiState(
  store: UiStateStore,
  id: string,
  next: PersistedUiState,
): Promise<{ ok: boolean; updatedAt: number }> {
  for (;;) {
    let refusedAt = 0;
    const updated = await store.update(id, (existing) => {
      if (existing.updatedAt > next.updatedAt) {
        refusedAt = existing.updatedAt;
        return existing;
      }
      return next;
    });
    if (refusedAt) return { ok: false, updatedAt: refusedAt };
    if (updated) return { ok: true, updatedAt: next.updatedAt };
    if (await store.insertIfAbsent(id, next)) return { ok: true, updatedAt: next.updatedAt };
  }
}
