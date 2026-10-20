import pg from "pg";
import { pgMigrationChecksum } from "../../src/persistence/pg-pool.ts";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { sleep } from "../../src/util/async.ts";
import { ITEMS_TABLES_SQL, ITEM_INDEXES, itemIndexSql, itemsMigration } from "../../src/sessions/items-schema.ts";
import { itemsCopySelectedSql, itemsSelectedRowsSql, ITEMS_COPY_REPAIR_SQL } from "../../src/sessions/items-copy.ts";

export const fingerprint = createHash("sha256")
  .update(JSON.stringify([ITEMS_TABLES_SQL, ITEM_INDEXES, ITEMS_COPY_REPAIR_SQL, itemsCopySelectedSql()]))
  .digest("hex");
const state = "items_copy_ops.state";
const dirty = "items_copy_ops.dirty";
const slices = "items_copy_ops.slices";
const SLICES_SQL = `CREATE TABLE IF NOT EXISTS ${slices}(slice int PRIMARY KEY,hi_session text,cursor_session text,cursor_seq int,
  scanned bigint NOT NULL DEFAULT 0,copied bigint NOT NULL DEFAULT 0,done boolean NOT NULL DEFAULT false)`;

export class ItemsCopyOperator {
  readonly client: pg.Client;
  readonly batch: number;
  constructor(client: pg.Client, batch = 2000) {
    this.client = client;
    this.batch = batch;
    if (!Number.isSafeInteger(batch) || batch < 1 || batch > 10000)
      throw new Error("batch must be between 1 and 10000");
  }

  async transaction<T>(run: () => Promise<T>, shared = false): Promise<T> {
    await this.client.query(
      "BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='120s'; SET LOCAL search_path=public",
    );
    try {
      const lock = `SELECT pg_try_advisory_xact_lock${shared ? "_shared" : ""}(hashtext('qm:schema-migrations')) AS acquired`;
      for (let attempt = 0; !(await this.client.query(lock)).rows[0].acquired; attempt++) {
        if (attempt >= 300) throw new Error("schema migration is running; retry after it completes");
        await sleep(1000);
      }
      const result = await run();
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.client.query("ROLLBACK");
      } catch (rollback) {
        throw new AggregateError([error, rollback], "items copy failed and rollback failed", { cause: rollback });
      }
      throw error;
    }
  }

  async prepare() {
    await this.transaction(async () => {
      if ((await this.client.query("SELECT to_regclass('public.items') AS existing")).rows[0].existing)
        throw new Error("items already exists; inspect it before preparing a new copy");
      await this.client.query(
        "LOCK TABLE public.session_entries, public.participants, public.directory_members, public.legacy_tape_steps IN SHARE ROW EXCLUSIVE MODE",
      );
      await this.client.query("CREATE SCHEMA items_copy_ops");
      for (const sql of ITEMS_TABLES_SQL) await this.client.query(sql);
      for (const sql of ITEMS_COPY_REPAIR_SQL) await this.client.query(sql);
      await this.client.query("CREATE EXTENSION IF NOT EXISTS btree_gin");
      await this.client.query(`CREATE TABLE ${state}(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
        source_oid oid NOT NULL, target_oid oid NOT NULL, tenant_id uuid NOT NULL, fingerprint text NOT NULL,
        phase text NOT NULL, cursor_session text, cursor_seq int, scanned bigint NOT NULL DEFAULT 0,
        copied bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`);
      await this.client.query(
        `INSERT INTO ${state}(source_oid,target_oid,tenant_id,fingerprint,phase)
        VALUES('public.session_entries'::regclass,'public.items'::regclass,(SELECT id FROM public.qm_tenant),$1,'copy')`,
        [fingerprint],
      );
      await this.client.query(
        `CREATE TABLE ${dirty}(session_id text PRIMARY KEY,version bigint NOT NULL DEFAULT 1,copy_version bigint,cursor_seq int,touched_at timestamptz NOT NULL DEFAULT now())`,
      );
      await this.client.query(`CREATE INDEX dirty_oldest ON ${dirty}(touched_at,session_id)`);
      await this.client.query(SLICES_SQL);
      await this.client.query(`INSERT INTO ${slices}(slice) VALUES(0)`);
      await this.client.query(`CREATE FUNCTION items_copy_ops.capture() RETURNS trigger LANGUAGE plpgsql AS $capture$
        BEGIN
          IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'TRUNCATE is disabled during items copy'; END IF;
          IF TG_TABLE_NAME='directory_members' THEN
            IF TG_OP='UPDATE' AND (OLD.principal_id,OLD.display_name_lc) IS NOT DISTINCT FROM (NEW.principal_id,NEW.display_name_lc) THEN RETURN NULL; END IF;
            INSERT INTO ${dirty}(session_id)
              SELECT DISTINCT session_id FROM participants
               WHERE principal_id IN (CASE WHEN TG_OP<>'INSERT' THEN OLD.principal_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.principal_id END)
               ORDER BY session_id
              ON CONFLICT(session_id) DO UPDATE SET version=${dirty}.version+1;
          ELSE
            IF TG_TABLE_NAME='participants' AND TG_OP='UPDATE' THEN
              IF (OLD.principal_id,OLD.session_id,OLD.valid_from,OLD.valid_to) IS NOT DISTINCT FROM (NEW.principal_id,NEW.session_id,NEW.valid_from,NEW.valid_to) THEN RETURN NULL; END IF;
            END IF;
            IF TG_OP<>'INSERT' THEN
              INSERT INTO ${dirty}(session_id) VALUES(OLD.session_id)
                ON CONFLICT(session_id) DO UPDATE SET version=${dirty}.version+1;
            END IF;
            IF TG_OP<>'DELETE' THEN
              INSERT INTO ${dirty}(session_id) VALUES(NEW.session_id)
                ON CONFLICT(session_id) DO UPDATE SET version=${dirty}.version+1;
            END IF;
          END IF;
          RETURN NULL;
        END $capture$`);
      for (const table of ["session_entries", "participants", "directory_members", "legacy_tape_steps"]) {
        await this.client.query(
          `CREATE TRIGGER items_copy_capture AFTER INSERT OR UPDATE OR DELETE ON public.${table} FOR EACH ROW EXECUTE FUNCTION items_copy_ops.capture()`,
        );
        await this.client.query(
          `CREATE TRIGGER items_copy_no_truncate BEFORE TRUNCATE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION items_copy_ops.capture()`,
        );
      }
    });
  }

  async assertState(phases: string[], lock: "UPDATE" | "SHARE" | "KEY SHARE" = "UPDATE") {
    const {
      rows: [cutover],
    } = await this.client.query(
      "SELECT EXISTS(SELECT 1 FROM public.qm_schema_migrations WHERE id LIKE 'sessions/store/%items-cutover') AS done",
    );
    if (cutover.done) throw new Error("items cutover is already applied; the legacy copy operator must not run");
    const {
      rows: [s],
    } = await this.client.query(
      `SELECT *,source_oid='public.session_entries'::regclass AND target_oid='public.items'::regclass AND tenant_id=(SELECT id FROM public.qm_tenant) AS same FROM ${state} FOR ${lock}`,
    );
    if (!s?.same || s.fingerprint !== fingerprint || !phases.includes(s.phase))
      throw new Error("copy source, target, mapping or phase changed; inspect status");
    const {
      rows: [t],
    } = await this.client.query(
      "SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid IN ('public.session_entries'::regclass,'public.participants'::regclass,'public.directory_members'::regclass,'public.legacy_tape_steps'::regclass) AND tgname IN ('items_copy_capture','items_copy_no_truncate') AND tgenabled='O'",
    );
    if (t.n !== 8) throw new Error("items copy change capture is missing or disabled");
    await this.client.query(
      "CREATE TEMP TABLE IF NOT EXISTS items_copy_batch(session_id text,seq int,PRIMARY KEY(session_id,seq)) ON COMMIT DELETE ROWS",
    );
    return s;
  }

  async replaceSelected() {
    await this.client.query(
      "SELECT id FROM public.sessions WHERE id IN (SELECT session_id FROM pg_temp.items_copy_batch) ORDER BY id FOR KEY SHARE",
    );
    await this.client.query(
      "DELETE FROM public.items i USING pg_temp.items_copy_batch b WHERE i.tenant_id=(SELECT id FROM public.qm_tenant) AND (i.session_id,i.seq)=(b.session_id,b.seq)",
    );
    return (await this.client.query(itemsCopySelectedSql())).rows[0];
  }

  async split(workers: number) {
    if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32)
      throw new Error("workers must be between 1 and 32");
    return this.transaction(async () => {
      const s = await this.assertState(["copy"]);
      if (!(await this.client.query(`SELECT to_regclass('${slices}') AS t`)).rows[0].t) {
        await this.client.query(SLICES_SQL);
        await this.client.query(`INSERT INTO ${slices}(slice,cursor_session,cursor_seq) VALUES(0,$1,$2)`, [
          s.cursor_session,
          s.cursor_seq,
        ]);
      }
      const { rows } = await this.client.query(`SELECT * FROM ${slices} ORDER BY slice FOR UPDATE`);
      const open = rows.filter((r) => !r.done);
      if (rows.length === workers || workers === 1) return rows.length;
      if (open.length !== 1)
        throw new Error(`copy is already split into ${rows.length} slices; rerun with --workers ${rows.length}`);
      const [from] = open;
      const {
        rows: [{ reltuples }],
      } = await this.client.query("SELECT reltuples FROM pg_class WHERE oid='public.session_entries'::regclass");
      const {
        rows: [{ bounds }],
      } = await this.client.query(
        `SELECT COALESCE(array_agg(DISTINCT b ORDER BY b),'{}') AS bounds FROM unnest((
           SELECT percentile_disc((SELECT array_agg(i::float8/$1) FROM generate_series(1,$1-1) i)) WITHIN GROUP (ORDER BY session_id)
             FROM public.session_entries TABLESAMPLE SYSTEM($2)
            WHERE ($3::text IS NULL OR session_id>$3) AND ($4::text IS NULL OR session_id<$4))) b
          WHERE b IS NOT NULL AND ($3::text IS NULL OR b>$3)`,
        [workers, Number(reltuples) > 1e6 ? 0.2 : 100, from.cursor_session, from.hi_session],
      );
      const his = [...bounds, from.hi_session];
      const base = Math.max(...rows.map((r) => r.slice)) + 1;
      await this.client.query(`UPDATE ${slices} SET hi_session=$2 WHERE slice=$1`, [from.slice, his[0]]);
      for (const [i, lo] of bounds.entries())
        await this.client.query(
          `INSERT INTO ${slices}(slice,hi_session,cursor_session,cursor_seq) VALUES($1,$2,$3,-1)`,
          [base + i, his[i + 1], lo],
        );
      return rows.length + bounds.length;
    });
  }

  async copyBatch(slice = 0) {
    return this.transaction(async () => {
      await this.assertState(["copy"], "SHARE");
      const {
        rows: [sl],
      } = await this.client.query(`SELECT * FROM ${slices} WHERE slice=$1 FOR UPDATE`, [slice]);
      if (!sl || sl.done) return 0;
      const params: unknown[] = [];
      const where: string[] = [];
      if (sl.cursor_session !== null)
        where.push(`(session_id,seq)>($${params.push(sl.cursor_session)},$${params.push(sl.cursor_seq)})`);
      if (sl.hi_session !== null) where.push(`session_id<$${params.push(sl.hi_session)}`);
      await this.client.query(
        `INSERT INTO pg_temp.items_copy_batch SELECT session_id,seq FROM public.session_entries
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY session_id,seq LIMIT $${params.push(this.batch)}`,
        params,
      );
      const {
        rows: [last],
      } = await this.client.query(
        "SELECT session_id,seq,(SELECT count(*)::int FROM pg_temp.items_copy_batch) AS n FROM pg_temp.items_copy_batch ORDER BY session_id DESC,seq DESC LIMIT 1",
      );
      if (!last) {
        await this.client.query(`UPDATE ${slices} SET done=true WHERE slice=$1`, [slice]);
        return 0;
      }
      const copied = await this.replaceSelected();
      await this.client.query(
        `UPDATE ${slices} SET cursor_session=$2,cursor_seq=$3,scanned=scanned+$4,copied=copied+$5 WHERE slice=$1`,
        [slice, last.session_id, last.seq, last.n, copied.rows],
      );
      return last.n as number;
    }, true);
  }

  async completeCopy() {
    return this.transaction(async () => {
      await this.assertState(["copy"]);
      const {
        rows: [open],
      } = await this.client.query(`SELECT count(*)::int AS n FROM ${slices} WHERE NOT done`);
      if (open.n) return false;
      await this.client.query(`UPDATE ${state} SET phase='catchup',updated_at=now()`);
      return true;
    });
  }

  async catchupBatch(worker = 0, workers = 1) {
    return this.transaction(async () => {
      await this.assertState(["catchup", "verified", "ready"], "KEY SHARE");
      return this.drainBatch(worker, workers);
    }, true);
  }

  async drainBatch(worker = 0, workers = 1) {
    await this.client.query("TRUNCATE pg_temp.items_copy_batch");
    const {
      rows: [entry],
    } = await this.client.query(
      `SELECT * FROM ${dirty}
        WHERE (hashtext(session_id)::bigint & 2147483647) % $2 = $1
        ORDER BY touched_at,session_id LIMIT 1`,
      [worker, workers],
    );
    if (!entry) return 0;
    const version = entry.copy_version ?? entry.version;
    const params = [entry.session_id, entry.cursor_seq ?? -1, this.batch];
    await this.client.query(
      `INSERT INTO pg_temp.items_copy_batch
        WITH a AS (SELECT seq FROM public.session_entries WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT $3),
             b AS (SELECT seq::int FROM public.items WHERE tenant_id=(SELECT id FROM public.qm_tenant) AND session_id=$1 AND seq>$2 ORDER BY seq LIMIT $3)
        SELECT $1,seq FROM (SELECT seq FROM a UNION SELECT seq FROM b) keys ORDER BY seq LIMIT $3`,
      params,
    );
    const {
      rows: [batch],
    } = await this.client.query("SELECT max(seq) AS last,count(*)::int AS n FROM pg_temp.items_copy_batch");
    if (batch.n) {
      await this.replaceSelected();
      await this.client.query(
        `UPDATE ${dirty} SET copy_version=$2,cursor_seq=$3,touched_at=clock_timestamp() WHERE session_id=$1`,
        [entry.session_id, version, batch.last],
      );
    } else {
      await this.client.query(`DELETE FROM ${dirty} WHERE session_id=$1 AND version=$2`, [entry.session_id, version]);
      await this.client.query(
        `UPDATE ${dirty} SET copy_version=NULL,cursor_seq=NULL,touched_at=clock_timestamp() WHERE session_id=$1`,
        [entry.session_id],
      );
    }
    await this.client.query(`UPDATE ${state} SET phase='catchup',updated_at=now()`);
    return batch.n || 1;
  }

  async indexes() {
    await this.transaction(async () => {
      await this.assertState(["catchup", "verified"]);
    });
    let acquired = false;
    try {
      for (let attempt = 0; !acquired; attempt++) {
        acquired = (
          await this.client.query("SELECT pg_try_advisory_lock_shared(hashtext('qm:schema-migrations')) AS ok")
        ).rows[0].ok;
        if (!acquired) {
          if (attempt >= 300) throw new Error("schema migration is running; retry after it completes");
          await sleep(1000);
        }
      }
      await this.client.query("SET search_path=public; SET statement_timeout=0; SET lock_timeout='5s'");
      for (const index of ITEM_INDEXES) {
        const {
          rows: [existing],
        } = await this.client.query(
          "SELECT i.indisvalid, i.indrelid='public.items'::regclass AS ours FROM pg_index i WHERE indexrelid=to_regclass($1)",
          [`public.${index.name}`],
        );
        if (existing && !existing.ours) throw new Error(`index ${index.name} belongs to another table`);
        if (existing?.indisvalid) continue;
        if (existing) await this.client.query(`DROP INDEX CONCURRENTLY public.${index.name}`);
        await this.client.query(itemIndexSql(index).replace("INDEX IF NOT EXISTS", "INDEX CONCURRENTLY IF NOT EXISTS"));
      }
    } finally {
      if (acquired) await this.client.query("SELECT pg_advisory_unlock_shared(hashtext('qm:schema-migrations'))");
    }
  }

  async finish(writersStopped: boolean, options: { retireLeases?: boolean } = {}) {
    if (!writersStopped)
      throw new Error("finish requires --writers-stopped; keep old writers stopped through the items cutover");
    await this.transaction(async () => {
      await this.client.query("SET LOCAL statement_timeout=0");
      await this.client.query(
        "LOCK TABLE public.session_entries,public.participants,public.directory_members,public.legacy_tape_steps IN SHARE ROW EXCLUSIVE MODE",
      );
      await this.assertState(["verified", "ready"]);
      if (options.retireLeases) await this.client.query("DELETE FROM public.session_leases");
      const {
        rows: [leases],
      } = await this.client.query(
        "SELECT count(*)::int AS n FROM public.session_leases WHERE expires_at>(extract(epoch FROM clock_timestamp())*1000)::bigint",
      );
      if (leases.n) throw new Error("active session leases remain; drain writers before finishing the copy");
      await this.snapshotDirty();
      for (let cursor: { session: string; seq: number } | null = { session: "", seq: -1 }; cursor;)
        cursor = (await this.bulkStep(cursor)).next;
      const {
        rows: [left],
      } = await this.client.query(`SELECT count(*)::int AS n FROM ${dirty}`);
      if (left.n) throw new Error("queued items changes remain after the final drain");
      const {
        rows: [{ valid }],
      } = await this.client.query(
        `SELECT count(*)::int AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          WHERE i.indrelid='public.items'::regclass AND i.indisvalid AND c.relname=ANY($1)`,
        [ITEM_INDEXES.map((index) => index.name)],
      );
      if (valid !== ITEM_INDEXES.length)
        throw new Error("build the items indexes before stopping writers: run indexes");
      const checksum = pgMigrationChecksum(itemsMigration.statements);
      const {
        rows: [recorded],
      } = await this.client.query("SELECT checksum FROM public.qm_schema_migrations WHERE id=$1", [itemsMigration.id]);
      if (recorded && recorded.checksum !== checksum)
        throw new Error("items migration checksum differs from the staged copy");
      await this.client.query(
        "INSERT INTO public.qm_schema_migrations(id,checksum) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
        [itemsMigration.id, checksum],
      );
      await this.client.query(`UPDATE ${state} SET phase='ready',updated_at=now()`);
    });
  }

  async verify() {
    await this.transaction(async () => {
      await this.assertState(["catchup", "verified", "ready"]);
      await this.client.query(`UPDATE ${state} SET phase='catchup',updated_at=now()`);
    });
    for (const table of ["public.session_entries", "public.items"]) {
      let cursor: [string, number] | null = null;
      for (;;) {
        const last = await this.transaction(async () => {
          await this.assertState(["catchup", "verified", "ready"]);
          const params = cursor === null ? [this.batch] : [...cursor, this.batch];
          const where = [
            table === "public.items" ? "tenant_id=(SELECT id FROM public.qm_tenant)" : "",
            cursor === null ? "" : "(session_id,seq)>($1,$2)",
          ]
            .filter(Boolean)
            .join(" AND ");
          await this.client.query(
            `INSERT INTO pg_temp.items_copy_batch SELECT session_id,seq FROM ${table}
            ${where ? `WHERE ${where}` : ""} ORDER BY session_id,seq LIMIT $${params.length}`,
            params,
          );
          const {
            rows: [row],
          } = await this.client.query(
            "SELECT session_id,seq FROM pg_temp.items_copy_batch ORDER BY session_id DESC,seq DESC LIMIT 1",
          );
          if (!row) return null;
          const expected = itemsSelectedRowsSql();
          const {
            rows: [diff],
          } = await this.client.query(`WITH expected AS (${expected}),
            actual AS (SELECT i.* FROM public.items i JOIN pg_temp.items_copy_batch b USING(session_id,seq)
                       WHERE tenant_id=(SELECT id FROM public.qm_tenant))
            SELECT count(*)::int AS n FROM (
              SELECT COALESCE(e.session_id,a.session_id) AS session_id,COALESCE(e.seq,a.seq) AS seq
              FROM expected e FULL JOIN actual a USING(tenant_id,session_id,seq)
              WHERE (to_jsonb(e)-'search'-'blob_sha') IS DISTINCT FROM (to_jsonb(a)-'search'-'blob_sha')
            ) d WHERE NOT EXISTS(SELECT 1 FROM ${dirty} q WHERE q.session_id=d.session_id)`);
          if (diff.n) throw new Error("items verification found differences without captured changes");
          return [row.session_id, row.seq] as [string, number];
        });
        if (!last) break;
        cursor = last;
      }
    }
    await this.transaction(async () => {
      await this.assertState(["catchup", "verified", "ready"]);
      const {
        rows: [duplicates],
      } = await this.client.query(`SELECT EXISTS(
        SELECT 1 FROM public.items WHERE call_id IS NOT NULL GROUP BY tenant_id,session_id,kind,call_id HAVING count(*)>1
      ) AS found`);
      if (duplicates.found) throw new Error("duplicate call IDs prevent the final items unique index");
      await this.client.query(`UPDATE ${state} SET phase='verified',updated_at=now()`);
    });
  }

  async cleanup() {
    await this.transaction(async () => {
      const {
        rows: [cutover],
      } = await this.client.query(
        "SELECT EXISTS(SELECT 1 FROM public.qm_schema_migrations WHERE id LIKE 'sessions/store/%items-cutover') AS done",
      );
      if (!cutover.done) throw new Error("cleanup requires the items cutover migration to be applied");
      for (const table of [
        "session_entries",
        "legacy_session_entries",
        "participants",
        "directory_members",
        "legacy_tape_steps",
      ]) {
        if ((await this.client.query("SELECT to_regclass($1) AS relation", [`public.${table}`])).rows[0].relation) {
          await this.client.query(`DROP TRIGGER IF EXISTS items_copy_capture ON public.${table}`);
          await this.client.query(`DROP TRIGGER IF EXISTS items_copy_no_truncate ON public.${table}`);
        }
      }
      await this.client.query("DROP FUNCTION IF EXISTS items_copy_ops.capture()");
      await this.client.query(`DROP TABLE IF EXISTS ${dirty},${state},${slices}`);
      await this.client.query("DROP SCHEMA IF EXISTS items_copy_ops");
    });
  }

  async report() {
    const { rows } = await this.client.query(`SELECT kind,count(*)::bigint AS rows,
      count(*) FILTER (WHERE author IS NULL)::bigint AS author_null,
      CASE WHEN kind IN ('UserMessage','SteeringMessage','ElicitationResponse') THEN
        round(100.0*count(*) FILTER (WHERE author IS NULL)/count(*),2) END AS author_null_percent
      FROM public.items GROUP BY kind ORDER BY kind`);
    return rows;
  }

  async status() {
    return (
      await this.client
        .query(`SELECT st.phase,st.scanned+sl.scanned AS scanned,st.copied+sl.copied AS initial_copied,sl.slices,sl.done,
      st.updated_at,(SELECT count(*) FROM ${dirty}) AS queued,pg_total_relation_size('public.items') AS bytes
      FROM ${state} st,(SELECT COALESCE(sum(scanned),0) AS scanned,COALESCE(sum(copied),0) AS copied,count(*)::int AS slices,
        count(*) FILTER (WHERE done)::int AS done FROM ${slices}) sl`)
    ).rows[0];
  }
  async snapshotDirty(worker = 0, workers = 1) {
    await this.client.query("DROP TABLE IF EXISTS pg_temp.items_copy_snap");
    await this.client.query(
      `CREATE TEMP TABLE items_copy_snap AS SELECT session_id,version FROM ${dirty}
        WHERE (hashtext(session_id)::bigint & 2147483647) % $2 = $1`,
      [worker, workers],
    );
    await this.client.query("ALTER TABLE pg_temp.items_copy_snap ADD PRIMARY KEY(session_id)");
    return (await this.client.query("SELECT count(*)::int AS n FROM pg_temp.items_copy_snap")).rows[0].n as number;
  }
  async bulkCatchupBatch(cursor: { session: string; seq: number }, window = 50) {
    return this.transaction(async () => {
      await this.assertState(["catchup", "verified", "ready"], "KEY SHARE");
      return this.bulkStep(cursor, window);
    }, true);
  }
  async bulkStep(cursor: { session: string; seq: number }, window = 50) {
    await this.client.query("TRUNCATE pg_temp.items_copy_batch");
    await this.client.query(
      `INSERT INTO pg_temp.items_copy_batch
        WITH s AS (SELECT session_id FROM pg_temp.items_copy_snap WHERE session_id>=$1 ORDER BY session_id LIMIT $4),
             k AS (SELECT e.session_id,e.seq FROM s JOIN public.session_entries e USING(session_id)
                   UNION SELECT i.session_id,i.seq::int FROM s JOIN public.items i
                     ON i.tenant_id=(SELECT id FROM public.qm_tenant) AND i.session_id=s.session_id)
        SELECT session_id,seq FROM k WHERE (session_id,seq)>($1,$2) ORDER BY session_id,seq LIMIT $3`,
      [cursor.session, cursor.seq, this.batch, window],
    );
    const {
      rows: [last],
    } = await this.client.query(
      "SELECT session_id,seq,(SELECT count(*)::int FROM pg_temp.items_copy_batch) AS n FROM pg_temp.items_copy_batch ORDER BY session_id DESC,seq DESC LIMIT 1",
    );
    const n = (last?.n ?? 0) as number;
    if (n) await this.replaceSelected();
    let done: string | null;
    let next: { session: string; seq: number } | null;
    if (n < this.batch) {
      const {
        rows: [w],
      } = await this.client.query(
        "SELECT max(session_id) AS hi FROM (SELECT session_id FROM pg_temp.items_copy_snap WHERE session_id>=$1 ORDER BY session_id LIMIT $2) s",
        [cursor.session, window],
      );
      done = w.hi;
      next =
        w.hi === null || (w.hi === cursor.session && cursor.seq === 2147483647)
          ? null
          : { session: w.hi, seq: 2147483647 };
      if (done !== null) await this.finishSnapshot("s.session_id>=$1 AND s.session_id<=$2", [cursor.session, done]);
    } else {
      next = { session: last.session_id, seq: last.seq };
      await this.finishSnapshot("s.session_id>=$1 AND s.session_id<$2", [cursor.session, last.session_id]);
    }
    return { rows: n, next };
  }
  async finishSnapshot(range: string, params: string[]) {
    await this.client.query(
      `DELETE FROM ${dirty} d USING pg_temp.items_copy_snap s
        WHERE d.session_id=s.session_id AND d.version=s.version AND ${range}`,
      params,
    );
    await this.client.query(
      `UPDATE ${dirty} d SET copy_version=NULL,cursor_seq=NULL FROM pg_temp.items_copy_snap s
        WHERE d.session_id=s.session_id AND ${range}`,
      params,
    );
  }
}

export async function catchupBulk(
  url: string,
  batch: number,
  workers: number,
  progress: (p: Record<string, unknown>) => void,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32)
    throw new Error("workers must be between 1 and 32");
  let failed: unknown = null;
  await Promise.all(
    Array.from({ length: workers }, async (_, worker) => {
      const client = new pg.Client({ connectionString: url, application_name: "qm-items-copy" });
      try {
        await client.connect();
        const op = new ItemsCopyOperator(client, batch);
        const sessions = await op.snapshotDirty(worker, workers);
        let cursor: { session: string; seq: number } | null = { session: "", seq: -1 };
        let rows = 0;
        let batches = 0;
        while (cursor && failed === null && !signal?.aborted) {
          const r = await op.bulkCatchupBatch(cursor);
          rows += r.rows;
          cursor = r.next;
          if (++batches % 20 === 0 || !cursor)
            progress({ worker, sessions, batches, rows, cursor: cursor?.session ?? null });
        }
      } catch (error) {
        failed ??= error;
      } finally {
        await client.end();
      }
    }),
  );
  if (failed !== null) throw failed;
  signal?.throwIfAborted();
}

export async function catchupParallel(
  url: string,
  batch: number,
  workers: number,
  progress: (value: Record<string, unknown>) => void,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32)
    throw new Error("workers must be between 1 and 32");
  let remaining = true;
  while (remaining && !signal?.aborted) {
    let failed: unknown = null;
    const counts = await Promise.all(
      Array.from({ length: workers }, async (_, worker) => {
        const client = new pg.Client({ connectionString: url, application_name: "qm-items-copy" });
        let batches = 0;
        try {
          await client.connect();
          const op = new ItemsCopyOperator(client, batch);
          while (failed === null && !signal?.aborted && (await op.catchupBatch(worker, workers))) {
            if (++batches % 20 === 0) progress({ worker, batches, ...(await op.status()) });
          }
          return Number((await op.status()).queued);
        } catch (error) {
          failed ??= error;
          return 0;
        } finally {
          await client.end();
        }
      }),
    );
    if (failed !== null) throw failed;
    remaining = counts.some((count) => count > 0);
  }
  signal?.throwIfAborted();
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      batch: { type: "string", default: "2000" },
      workers: { type: "string", default: "1" },
      "writers-stopped": { type: "boolean", default: false },
    },
  });
  const action = positionals[0];
  if (
    !["prepare", "copy", "catchup", "indexes", "verify", "status", "report", "finish", "cleanup"].includes(action ?? "")
  )
    throw new Error(
      "usage: node scripts/ops/items-copy.ts prepare|copy|catchup|indexes|verify|status|report|finish|cleanup [--batch 2000] [--workers 1] [--writers-stopped]",
    );
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must name the direct Postgres endpoint");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: "qm-items-copy" });
  await client.connect();
  try {
    const op = new ItemsCopyOperator(client, Number(values.batch));
    if (action !== "status") {
      const {
        rows: [lock],
      } = await client.query("SELECT pg_try_advisory_lock(hashtext('qm:items-copy')) AS acquired");
      if (!lock.acquired) throw new Error("another items copy operator is running");
    }
    if (action === "cleanup") {
      await op.cleanup();
      console.log("items copy temporary state removed");
      return;
    }
    if (action === "prepare") await op.prepare();
    if (action === "indexes") await op.indexes();
    if (action === "verify") await op.verify();
    if (action === "finish") await op.finish(values["writers-stopped"]);
    if (action === "report") console.log(JSON.stringify(await op.report()));
    if (action === "copy") {
      await op.split(Number(values.workers));
      let failed: unknown = null;
      await Promise.all(
        (await client.query(`SELECT slice FROM ${slices} WHERE NOT done ORDER BY slice`)).rows.map(
          async ({ slice }) => {
            const worker = new pg.Client({
              connectionString: process.env.DATABASE_URL,
              application_name: "qm-items-copy",
            });
            await worker.connect();
            try {
              const w = new ItemsCopyOperator(worker, op.batch);
              for (let batches = 1; failed === null && (await w.copyBatch(slice)); batches++)
                if (batches % 20 === 0) console.log(JSON.stringify({ slice, ...(await w.status()) }));
            } catch (error) {
              failed ??= error;
            } finally {
              await worker.end();
            }
          },
        ),
      );
      if (failed !== null) throw failed;
      await op.completeCopy();
    }
    if (action === "catchup") {
      await catchupParallel(process.env.DATABASE_URL, op.batch, Number(values.workers), (value) =>
        console.log(JSON.stringify(value)),
      );
    }
    console.log(JSON.stringify(await op.status()));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
