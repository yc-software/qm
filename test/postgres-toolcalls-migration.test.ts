import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the tool_calls migration tests";

type Pg = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};
async function pool(): Promise<Pg> {
  const pg = (await import("pg")).default;
  return new pg.Pool({ connectionString: URL }) as unknown as Pg;
}

async function pkColumns(p: Pg): Promise<{ oid: string; columns: string[] } | undefined> {
  const { rows } = await p.query(`
    SELECT c.oid::text AS oid,
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
    FROM pg_constraint c
    WHERE c.conrelid = 'tool_calls'::regclass AND c.contype = 'p'`);
  const row = rows[0];
  return row ? { oid: row.oid as string, columns: row.columns as string[] } : undefined;
}

async function bootAndClose(): Promise<void> {
  const { runs, close } = createPostgresRunStore(URL!);
  await runs.enqueue({ sessionId: "sMigrationPing", request: { text: "ping" } as never }).catch(() => undefined);
  await close();
}

before(async () => {
  if (!URL) return;
  const p = await pool();
  await p.query("DROP TABLE IF EXISTS runs, tool_calls CASCADE");
  await p.end();
});

// leave a clean slate for suites sharing this database
after(async () => {
  if (!URL) return;
  const p = await pool();
  await p.query("DROP TABLE IF EXISTS runs, tool_calls CASCADE");
  await p.end();
});

test("tool_calls: a keyless table with duplicates heals on boot, keeping the newest row", { skip }, async () => {
  const p = await pool();
  // the mid-crash state the old migration could leave: attempt column present, no PK, duplicates written
  await p.query(`CREATE TABLE tool_calls(
      run_id TEXT NOT NULL, attempt INT NOT NULL DEFAULT 1, call_index INT NOT NULL,
      output TEXT NOT NULL, created_at BIGINT NOT NULL)`);
  await p.query(`INSERT INTO tool_calls VALUES
      ('r1', 1, 0, 'older', 100), ('r1', 1, 0, 'newer', 200), ('r1', 1, 1, 'only', 150)`);
  await bootAndClose();
  const pk = await pkColumns(p);
  assert.deepEqual(pk?.columns, ["run_id", "attempt", "call_index"], "primary key restored");
  const { rows } = await p.query("SELECT output FROM tool_calls WHERE run_id='r1' AND attempt=1 AND call_index=0");
  assert.deepEqual(rows, [{ output: "newer" }], "newest duplicate survives");
  await p.end();
});

test("tool_calls: a legacy two-column key migrates to (run_id, attempt, call_index)", { skip }, async () => {
  const p = await pool();
  await p.query("DROP TABLE IF EXISTS tool_calls");
  await p.query(`CREATE TABLE tool_calls(
      run_id TEXT NOT NULL, call_index INT NOT NULL, output TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY(run_id, call_index))`);
  await p.query("INSERT INTO tool_calls VALUES ('r2', 0, 'kept', 100)");
  await bootAndClose();
  const pk = await pkColumns(p);
  assert.deepEqual(pk?.columns, ["run_id", "attempt", "call_index"]);
  const { rows } = await p.query("SELECT output FROM tool_calls WHERE run_id='r2'");
  assert.deepEqual(rows, [{ output: "kept" }], "existing row survives the migration");
  await p.end();
});

test("tool_calls: a boot with the current key leaves the constraint untouched", { skip }, async () => {
  const p = await pool();
  const beforePk = await pkColumns(p);
  assert.ok(beforePk, "previous test left the migrated key in place");
  await bootAndClose();
  const afterPk = await pkColumns(p);
  assert.deepEqual(afterPk?.columns, ["run_id", "attempt", "call_index"]);
  assert.equal(afterPk?.oid, beforePk?.oid, "constraint not dropped and recreated on a routine boot");
  await p.end();
});
