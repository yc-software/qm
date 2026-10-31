import { createPgPool } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { currentTenant } from "../tenants/context.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { errMessage } from "../util/errors.ts";

export interface IdempotencyStore {
  once(key: string, fn: () => Promise<void>): Promise<boolean>;
  committed(key: string): Promise<boolean>;
  close?(): Promise<void>;
}

export interface IdempotencyStoreOptions {
  retentionMs?: number;
  pruneIntervalMs?: number;
  now?: () => number;
}

interface CommitLog {
  committedAt(key: string): Promise<number | null>;
  commit(key: string, at: number): Promise<void>;
  prune(cutoff: number): Promise<void>;
}

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60_000;

const IDEMPOTENCY_MIGRATION = typedTableMigration({
  table: "idempotency",
  columns: ["key TEXT NOT NULL", "committed_at BIGINT NOT NULL"],
  primaryKey: ["key"],
  backfill: { key: "id", committed_at: "round((json->>'at')::numeric)::bigint" },
  where: "json->>'at' IS NOT NULL",
  indexes: ["CREATE INDEX idempotency_by_committed_at ON idempotency(tenant_id, committed_at)"],
});

function idempotencyStore(log: CommitLog, opts: IdempotencyStoreOptions): IdempotencyStore {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const done = new Map<string, number>();
  const inflight = new Set<string>();
  const lastPruneAt = new Map<string, number>();
  const startedAt = now();
  const tenantKey = (key: string) => `${currentTenant()}\u0000${key}`;

  function pruneIfDue(t: number): void {
    const tenant = currentTenant();
    if (t - (lastPruneAt.get(tenant) ?? startedAt) < pruneIntervalMs) return;
    lastPruneAt.set(tenant, t);
    const cutoff = t - retentionMs;
    for (const [key, at] of done) if (at < cutoff) done.delete(key);
    log.prune(cutoff).catch((e: unknown) => {
      console.error("[idempotency] retention prune failed:", errMessage(e));
    });
  }

  const isCommitted = async (key: string): Promise<boolean> => {
    const cutoff = now() - retentionMs;
    const cached = done.get(tenantKey(key));
    if (cached != null && cached >= cutoff) return true;
    const at = await log.committedAt(key);
    if (at != null && at >= cutoff) {
      done.set(tenantKey(key), at);
      return true;
    }
    return false;
  };

  return {
    async once(key, fn) {
      const slot = tenantKey(key);
      if (inflight.has(slot)) return false;
      inflight.add(slot);
      try {
        if (await isCommitted(key)) return false;
        await fn();
        const at = now();
        await log.commit(key, at);
        done.set(slot, at);
        pruneIfDue(at);
        return true;
      } finally {
        inflight.delete(slot);
      }
    },
    committed: isCommitted,
  };
}

export function createPostgresIdempotencyStore(
  connectionString: string,
  opts: IdempotencyStoreOptions = {},
): IdempotencyStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, IDEMPOTENCY_MIGRATION]);
  const log: CommitLog = {
    async committedAt(key) {
      const rows = await q(`SELECT committed_at FROM idempotency WHERE tenant_id = ${TENANT} AND key = $1`, [key]);
      return rows[0] ? Number(rows[0].committed_at) : null;
    },
    async commit(key, at) {
      await q(
        `INSERT INTO idempotency(key, committed_at) VALUES ($1, $2)
         ON CONFLICT (tenant_id, key) DO UPDATE SET committed_at = EXCLUDED.committed_at`,
        [key, at],
      );
    },
    async prune(cutoff) {
      await q(`DELETE FROM idempotency WHERE tenant_id = ${TENANT} AND committed_at < $1`, [cutoff]);
    },
  };
  return { ...idempotencyStore(log, opts), close };
}
