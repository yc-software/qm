import type { DurableMap } from "../persistence/durable-map.ts";
import { errMessage } from "../util/errors.ts";

export interface IdempotencyRecord {
  key: string;
  at: number;
}

export interface IdempotencyStore {
  once(key: string, fn: () => Promise<void>): Promise<boolean>;
  committed(key: string): Promise<boolean>;
}

export interface IdempotencyStoreOptions {
  retentionMs?: number;
  pruneIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60_000;

export function createIdempotencyStore(
  backing?: DurableMap<IdempotencyRecord>,
  opts: IdempotencyStoreOptions = {},
): IdempotencyStore {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const done = new Map<string, number>();
  const inflight = new Set<string>();
  let lastPruneAt = now();

  function pruneIfDue(t: number): void {
    if (t - lastPruneAt < pruneIntervalMs) return;
    lastPruneAt = t;
    const cutoff = t - retentionMs;
    for (const [key, at] of done) if (at < cutoff) done.delete(key);
    if (!backing) return;
    void (async () => {
      for (const r of await backing.all()) {
        if (r.at < cutoff) await backing.delete(r.key);
      }
    })().catch((e: unknown) => {
      console.error("[idempotency] retention prune failed:", errMessage(e));
    });
  }

  const isCommitted = async (key: string): Promise<boolean> => {
    const cutoff = now() - retentionMs;
    const cached = done.get(key);
    if (cached != null && cached >= cutoff) return true;
    const record = backing ? await backing.get(key) : null;
    if (record != null && record.at >= cutoff) {
      done.set(record.key, record.at);
      return true;
    }
    return false;
  };

  return {
    async once(key, fn) {
      if (inflight.has(key)) return false;
      inflight.add(key);
      try {
        if (await isCommitted(key)) return false;
        await fn();
        const at = now();
        await backing?.put(key, { key, at });
        done.set(key, at);
        pruneIfDue(at);
        return true;
      } finally {
        inflight.delete(key);
      }
    },
    committed: isCommitted,
  };
}
