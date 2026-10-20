import pg from "pg";
import { applyPgMigrations, definePgMigration, pgMigrationChecksum, pgCaOptions } from "../persistence/pg-pool.ts";
import { ItemsCopyOperator, fingerprint as itemsCopyFingerprint } from "../../scripts/ops/items-copy.ts";
import { ITEM_INDEXES, itemsMigration } from "./items-schema.ts";
import { ITEMS_CUTOVER_SQL } from "./items-cutover.ts";

export const ITEMS_CUTOVER_ID = "sessions/store/0036-items-cutover";

export async function createItemsPromotion(connectionString: string, options: { analyze?: boolean } = {}) {
  const pool = new pg.Pool({ connectionString, ...pgCaOptions(), max: 2 });
  let ready = false;
  let running: Promise<void> | undefined;
  let refreshing: Promise<boolean> | undefined;
  const waiters = new Set<() => void>();
  async function completed(): Promise<boolean> {
    const { rows } = await pool.query("SELECT id,checksum FROM qm_schema_migrations WHERE id=ANY($1)", [
      [itemsMigration.id, ITEMS_CUTOVER_ID],
    ]);
    const expected = new Map([
      [itemsMigration.id, pgMigrationChecksum(itemsMigration.statements)],
      [ITEMS_CUTOVER_ID, pgMigrationChecksum(ITEMS_CUTOVER_SQL)],
    ]);
    for (const row of rows)
      if (expected.get(row.id) !== row.checksum) throw new Error("Items promotion migration checksum mismatch");
    return rows.length === expected.size;
  }
  async function validate(): Promise<void> {
    if (await completed()) return;
    const { rows } = await pool.query(
      `SELECT phase,source_oid='public.session_entries'::regclass AS source_valid,
      target_oid='public.items'::regclass AS target_valid, fingerprint=$1 AS mapping_valid,
      tenant_id=(SELECT id FROM public.qm_tenant) AS tenant_valid FROM items_copy_ops.state`,
      [itemsCopyFingerprint],
    );
    if (
      rows.length !== 1 ||
      !["verified", "ready"].includes(rows[0].phase) ||
      !rows[0].source_valid ||
      !rows[0].target_valid ||
      !rows[0].mapping_valid ||
      !rows[0].tenant_valid
    )
      throw new Error("Items promotion requires a verified staged copy");
    const indexes = await pool.query(
      `SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid='public.items'::regclass AND i.indisvalid AND c.relname=ANY($1)`,
      [ITEM_INDEXES.map((i) => i.name)],
    );
    if (indexes.rows[0].n !== ITEM_INDEXES.length) throw new Error("Items promotion requires all indexes ready");
    const triggers = await pool.query(`SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgrelid IN ('public.session_entries'::regclass,'public.participants'::regclass,
        'public.directory_members'::regclass,'public.legacy_tape_steps'::regclass)
      AND tgname IN ('items_copy_capture','items_copy_no_truncate') AND tgenabled='O'`);
    if (triggers.rows[0].n !== 8) throw new Error("Items promotion requires live change capture");
  }
  function release(): void {
    ready = true;
    for (const resolve of waiters) resolve();
    waiters.clear();
  }
  try {
    await validate();
    if (await completed()) release();
    else if (options.analyze) await pool.query("ANALYZE public.items");
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    ready: () => ready,
    async preflight(): Promise<void> {
      if (!ready) await validate();
    },
    async refresh(): Promise<boolean> {
      if (ready) return true;
      return (refreshing ??= (async () => {
        if (await completed()) release();
        return ready;
      })().finally(() => {
        refreshing = undefined;
      }));
    },
    async promote(writersStopped: boolean): Promise<void> {
      if (!writersStopped) throw new Error("Items promotion requires confirmed stopped writers");
      if (ready) return;
      await (running ??= (async () => {
        const guard = await pool.connect();
        try {
          await guard.query("SELECT pg_advisory_lock(hashtext('qm:items-promotion'))");
          await validate();
          if (!(await completed())) {
            const client = new pg.Client({
              connectionString,
              ...pgCaOptions(),
              application_name: "qm-items-promotion",
            });
            await client.connect();
            try {
              await new ItemsCopyOperator(client).finish(true, { retireLeases: true });
            } finally {
              await client.end();
            }
            await applyPgMigrations(pool, [definePgMigration(ITEMS_CUTOVER_ID, ITEMS_CUTOVER_SQL)]);
          }
          release();
        } finally {
          try {
            await guard.query("SELECT pg_advisory_unlock(hashtext('qm:items-promotion'))");
          } finally {
            guard.release();
          }
        }
      })().finally(() => {
        running = undefined;
      }));
    },
    wait(signal?: AbortSignal): Promise<void> {
      if (ready) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const finish = () => {
          waiters.delete(finish);
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          waiters.delete(finish);
          reject(signal?.reason);
        };
        if (signal?.aborted) return abort();
        waiters.add(finish);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
    close: () => pool.end(),
  };
}

export type ItemsPromotion = Awaited<ReturnType<typeof createItemsPromotion>>;
