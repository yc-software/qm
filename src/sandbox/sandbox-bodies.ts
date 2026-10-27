import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import {
  cols,
  mapToTableMigration,
  retireJsonKeysMigration,
  typedTable,
  type ColumnSpec,
  type MapConversion,
} from "../persistence/typed-table.ts";

const BODY_COLUMNS: Record<string, ColumnSpec> =
  cols(`initializationPending boolean, lastSnapshotMs bigint, homeDirty boolean, snapshotError text,
    checkpointId text, checkpointAtMs bigint`);

export function sandboxBodiesMigration(
  table: string,
  extra: Record<string, ColumnSpec> = {},
  opts: { dropKeys?: readonly string[] } = {},
): MapConversion {
  return mapToTableMigration(
    `sandbox/${table}/0001-typed`,
    { table, key: "scopeId", columns: { ...BODY_COLUMNS, ...extra } },
    opts,
  );
}

export function withRetiredColumns(typed: MapConversion, legacy: Readonly<Record<string, ColumnSpec>>): MapConversion {
  const { table } = typed.spec;
  return {
    ...typed,
    spec: { ...typed.spec, columns: { ...typed.spec.columns, ...legacy } },
    before: [
      retireJsonKeysMigration(`sandbox/${table}/0000-retired-columns`, table, { columns: legacy }),
      retireJsonKeysMigration(`contract/sandbox/${table}/0000-retired-columns`, table, { columns: legacy }),
    ],
  };
}

export function createSandboxBodies<T extends object>(databaseUrl: string, migration: MapConversion) {
  const { table } = migration.spec;
  const db = createPgPool(databaseUrl, [migration]);
  const { q } = db;
  const rows = typedTable<T>(db, migration.spec);
  const { codec } = rows;
  const names = codec.columns.split(", ");
  const fields = Object.keys(migration.spec.columns);
  const patched = (scopeId: string, patch: Partial<T>) => {
    const values = codec.values(scopeId, patch as T);
    const picked = fields.flatMap((field, i) => (Object.hasOwn(patch, field) ? [i + 1] : []));
    return { cols: picked.map((i) => names[i]!), params: [scopeId, ...picked.map((i) => values[i])] };
  };
  return {
    get: rows.get,
    delete: rows.delete,
    entries: async (): Promise<Array<[string, T]>> =>
      (await q(`SELECT ${codec.columns} FROM ${table} ORDER BY scope_id`)).map((r) => [
        r.scope_id as string,
        codec.row(r),
      ]),
    async update(scopeId: string, patch: Partial<T>): Promise<void> {
      const { cols, params } = patched(scopeId, patch);
      if (cols.length)
        await q(`UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE scope_id = $1`, params);
    },
    async upsert(scopeId: string, patch: Partial<T>): Promise<void> {
      const { cols, params } = patched(scopeId, patch);
      const set = cols.length ? `UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}` : "NOTHING";
      await q(
        `INSERT INTO ${table} (${["scope_id", ...cols].join(", ")}) VALUES (${params.map((_, i) => `$${i + 1}`).join(", ")})
         ON CONFLICT (${tenantCols("scope_id")}) DO ${set}`,
        params,
      );
    },
  };
}

export type SandboxBodies<T extends object> = ReturnType<typeof createSandboxBodies<T>>;
