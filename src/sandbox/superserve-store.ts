import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { jsonBackfill } from "../persistence/typed-statements.ts";
import { pgRows, type KeyedRows, type RowColumns, type RowTable } from "../persistence/keyed-rows.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";

export interface StoredSuperserveSandbox {
  sandboxId: string;
  createdAtMs: number;
}

export interface StoredConfigEpoch {
  generation: number;
}

const BODY_COLUMNS: RowColumns<StoredSuperserveSandbox, "scopeId"> = {
  scopeId: "text",
  sandboxId: "text",
  createdAtMs: "bigint",
};

export const SUPERSERVE_SANDBOX_BODIES: RowTable<StoredSuperserveSandbox, "scopeId"> = {
  table: "superserve_sandbox_bodies",
  key: "scopeId",
  columns: BODY_COLUMNS,
  migrations: [
    typedTableMigration({
      table: "superserve_sandbox_bodies",
      columns: ["scope_id TEXT NOT NULL", "sandbox_id TEXT NOT NULL", "created_at_ms BIGINT NOT NULL"],
      primaryKey: ["scope_id"],
      backfill: { ...jsonBackfill("superserve_sandbox_bodies", BODY_COLUMNS), scope_id: "id" },
    }),
  ],
};

export const SUPERSERVE_CONFIG_EPOCHS: RowTable<StoredConfigEpoch, "generationKey"> = {
  table: "superserve_config_epochs",
  key: "generationKey",
  global: true,
  columns: { generationKey: "text", generation: "bigint" },
  migrations: [
    {
      id: "tenancy/superserve_config_epochs/0001-typed",
      statements: [
        `SET LOCAL lock_timeout = '5s'`,
        `CREATE TABLE IF NOT EXISTS superserve_config_epochs(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
        `ALTER TABLE superserve_config_epochs RENAME TO superserve_config_epochs_kv`,
        `ALTER INDEX superserve_config_epochs_pkey RENAME TO superserve_config_epochs_kv_pkey`,
        `CREATE TABLE superserve_config_epochs(generation_key TEXT PRIMARY KEY, generation BIGINT NOT NULL)`,
        `INSERT INTO superserve_config_epochs(generation_key, generation)
           SELECT id, (json->>'generation')::bigint FROM superserve_config_epochs_kv
            WHERE jsonb_typeof(json->'generation') = 'number'`,
        `DROP TABLE superserve_config_epochs_kv`,
        `DO $drop_version$ BEGIN
           IF to_regclass('durable_map_versions') IS NOT NULL THEN
             DELETE FROM durable_map_versions WHERE tbl = 'superserve_config_epochs';
           END IF;
         END $drop_version$`,
      ],
    },
  ],
};

export interface SuperserveBodies extends Pick<KeyedRows<StoredSuperserveSandbox>, "get" | "put" | "delete"> {
  forget(scopeId: string, sandboxId: string): Promise<void>;
}

export function createSuperserveBodies(databaseUrl: string): SuperserveBodies {
  const rows = pgRows(databaseUrl, SUPERSERVE_SANDBOX_BODIES);
  return {
    get: rows.get,
    put: rows.put,
    delete: rows.delete,
    forget: async (scopeId, sandboxId) => {
      await rows.db.query(
        `DELETE FROM superserve_sandbox_bodies WHERE ${rows.scoped("scope_id = $1 AND sandbox_id = $2")}`,
        [scopeId, sandboxId],
      );
    },
  };
}

export function createSuperserveConfigEpochs(databaseUrl: string): KeyedRows<StoredConfigEpoch> {
  return pgRows(databaseUrl, SUPERSERVE_CONFIG_EPOCHS);
}

const CONFIG_EPOCH_LOCK = "superserve-config-epoch";

export function createConfigEpochResolver(
  store: Pick<KeyedRows<StoredConfigEpoch>, "get" | "entries" | "put">,
  generationKey: string,
  lock: AdvisoryLock,
): () => Promise<number> {
  let pending: Promise<number> | undefined;
  const claim = (): Promise<number> =>
    lock.withLock(CONFIG_EPOCH_LOCK, async () => {
      const stored = await store.get(generationKey);
      if (stored) return stored.generation;
      const generation = (await store.entries()).reduce((high, [, seen]) => Math.max(high, seen.generation), 0) + 1;
      await store.put(generationKey, { generation });
      return (await store.get(generationKey))?.generation ?? generation;
    });
  return () => {
    pending ??= claim().catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}
