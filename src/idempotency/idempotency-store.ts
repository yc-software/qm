import { randomUUID } from "node:crypto";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { errMessage } from "../util/errors.ts";
import { perTenant } from "../tenant.ts";

interface IdempotencyRecord {
  key: string;
  at: number;
  claim?: string;
}

export interface IdempotencyStore {
  once(key: string, fn: () => Promise<void>): Promise<boolean>;
  committed(key: string): Promise<boolean>;
}

export interface IdempotencyStoreOptions {
  retentionMs?: number;
  pruneIntervalMs?: number;
  claimLeaseMs?: number;
  now?: () => number;
}

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60_000;
const DEFAULT_CLAIM_LEASE_MS = 10 * 60_000;

const IDEMPOTENCY: TableSpec = {
  table: "idempotency",
  key: "key",
  keyIsField: true,
  columns: cols(`at bigint!, claim text`),
};

const IDEMPOTENCY_MIGRATION = mapToTableMigration("idempotency/store/0001-typed", IDEMPOTENCY, {
  statements: [`CREATE INDEX IF NOT EXISTS idempotency_at ON idempotency (at)`],
});

export function createIdempotencyStore(databaseUrl: string, opts: IdempotencyStoreOptions = {}): IdempotencyStore {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const claimLeaseMs = opts.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  const now = opts.now ?? Date.now;
  const pg = createPgPool(databaseUrl, [IDEMPOTENCY_MIGRATION]);
  const { codec, ...table } = typedTable<IdempotencyRecord>(pg, IDEMPOTENCY);
  const state = perTenant(() => ({ done: new Map<string, number>(), lastPruneAt: now() }));
  const done = () => state().done;

  function pruneIfDue(t: number): void {
    const s = state();
    if (t - s.lastPruneAt < pruneIntervalMs) return;
    s.lastPruneAt = t;
    const cutoff = t - retentionMs;
    for (const [key, at] of s.done) if (at < cutoff) s.done.delete(key);
    void pg.q(`DELETE FROM idempotency WHERE at < $1`, [cutoff]).catch((e: unknown) => {
      console.error("[idempotency] retention prune failed:", errMessage(e));
    });
  }

  const isCommitted = async (key: string): Promise<boolean> => {
    const cutoff = now() - retentionMs;
    const cached = done().get(key);
    if (cached != null && cached >= cutoff) return true;
    const record = await table.get(key);
    if (record != null && !record.claim && record.at >= cutoff) {
      done().set(record.key, record.at);
      return true;
    }
    return false;
  };

  async function claimKey(key: string): Promise<string | null> {
    const t = now();
    const claim = randomUUID();
    const rows = await pg.q(
      `INSERT INTO idempotency (${codec.columns}) VALUES (${codec.placeholders})
       ON CONFLICT (${tenantCols("key")}) DO UPDATE SET at = EXCLUDED.at, claim = EXCLUDED.claim
       WHERE CASE WHEN idempotency.claim IS NULL THEN idempotency.at < $4 ELSE idempotency.at <= $5 END
       RETURNING claim`,
      [...codec.values(key, { key, at: t, claim }), t - retentionMs, t - claimLeaseMs],
    );
    return rows[0]?.claim === claim ? claim : null;
  }

  return {
    async once(key, fn) {
      if (await isCommitted(key)) return false;
      const claim = await claimKey(key);
      if (!claim) return false;
      try {
        await fn();
      } catch (error) {
        await pg.q(`DELETE FROM idempotency WHERE key = $1 AND claim = $2`, [key, claim]);
        throw error;
      }
      const at = now();
      await table.put(key, { key, at });
      done().set(key, at);
      pruneIfDue(at);
      return true;
    },
    committed: isCommitted,
  };
}
