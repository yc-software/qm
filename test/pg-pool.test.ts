import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createPgPool,
  assertOneStatement,
  concurrentIndexName,
  definePgMigration,
  pgMigrationChecksum,
} from "../src/persistence/pg-pool.ts";

test("createPgPool is lazy: building it neither connects nor throws (no DB needed)", async () => {
  const pg = createPgPool("postgres://does-not-exist:0/none", "test/lazy/0001", ["SELECT 1"]);
  await assert.doesNotReject(pg.close());
});

test("importing pg-pool does NOT pull `pg` into the runtime import graph (zero-dep seam)", () => {
  const poolUrl = pathToUrl(fileURLToPath(new URL("../src/persistence/pg-pool.ts", import.meta.url)));
  const loader =
    "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(specifier, ctx, next) {
         if (specifier === "pg" || specifier.endsWith("/pg")) {
           throw new Error("FORBIDDEN: pg was loaded eagerly");
         }
         return next(specifier, ctx);
       }`,
    );
  const script = `
    import { register } from "node:module";
    register(${JSON.stringify(loader)});
    const { createPgPool } = await import(${JSON.stringify(poolUrl)});
    const p = createPgPool("postgres://x/y", "test/invalid/0001", ["SELECT 1"]);
    await p.close();
    console.log("OK");
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.match(out, /OK/);
});

test("assertOneStatement: a lone statement (with or without a trailing ;) is accepted", () => {
  assert.doesNotThrow(() => assertOneStatement("CREATE TABLE IF NOT EXISTS t(id TEXT)"));
  assert.doesNotThrow(() => assertOneStatement("SELECT 1;"));
});

test("assertOneStatement: two statements jammed into one element are rejected", () => {
  assert.throws(
    () =>
      assertOneStatement("ALTER TABLE t ADD COLUMN IF NOT EXISTS a INT; ALTER TABLE t ADD COLUMN IF NOT EXISTS b INT"),
    /single statement/,
  );
});

test("assertOneStatement: a dollar-quoted DO block with inner semicolons is one statement", () => {
  assert.doesNotThrow(() =>
    assertOneStatement(`DO $$
    BEGIN
      ALTER TABLE t ADD COLUMN IF NOT EXISTS a INT;
      ALTER TABLE t ADD COLUMN IF NOT EXISTS b INT;
    END $$`),
  );
});

test("assertOneStatement: a single-quoted literal or line comment containing ';' is not a split", () => {
  assert.doesNotThrow(() => assertOneStatement("INSERT INTO t(x) VALUES ('a;b')"));
  assert.doesNotThrow(() => assertOneStatement("CREATE INDEX i ON t(x) -- one; statement\n"));
});

test("assertOneStatement: an apostrophe in a line comment can't hide a following statement's ';'", () => {
  assert.throws(() => assertOneStatement("SELECT 1 -- don't\n; SELECT 'x'"), /single statement/);
});

test("migration checksums are stable and sensitive to statement changes", () => {
  assert.equal(pgMigrationChecksum([" SELECT 1 ", "SELECT 2;"]), pgMigrationChecksum(["SELECT 1", "SELECT 2;"]));
  assert.notEqual(pgMigrationChecksum(["SELECT 1"]), pgMigrationChecksum(["SELECT 2"]));
});

test("released migrations can pin their source checksum", () => {
  const migration = definePgMigration("test/pinned/0001", ["SELECT 1"]);
  assert.equal(definePgMigration("test/pinned/0001", ["SELECT 1"], migration.checksum).checksum, migration.checksum);
  assert.throws(
    () => definePgMigration("test/pinned/0001", ["SELECT 2"], migration.checksum),
    /source checksum mismatch/,
  );
});

test("migration definitions reject invalid ids and multi-statement elements", () => {
  assert.throws(() => definePgMigration("../bad", ["SELECT 1"]), /migration id/);
  assert.throws(() => definePgMigration("test/good/0001", ["SELECT 1; SELECT 2"]), /single statement/);
});

test("concurrentIndexName recognizes retryable concurrent index creation", () => {
  assert.equal(
    concurrentIndexName("CREATE INDEX CONCURRENTLY IF NOT EXISTS session_search ON sessions(id)"),
    "session_search",
  );
  assert.equal(concurrentIndexName("CREATE INDEX IF NOT EXISTS session_search ON sessions(id)"), undefined);
});

function pathToUrl(p: string): string {
  return new URL(`file://${p}`).href;
}

test("committed migrations survive an unlock failure while the broken connection is discarded", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { applyPgMigrations } = await import("../src/persistence/pg-pool.ts");
  const releases: boolean[] = [];
  let recorded = false;
  const client = Object.assign(new EventEmitter(), {
    query: async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("INSERT INTO qm_schema_migrations")) recorded = true;
      if (sql.includes("pg_advisory_unlock")) throw new Error("unlock connection reset");
      return { rows: [] };
    },
    release: (broken: boolean) => releases.push(broken),
  });
  const log = t.mock.method(console, "error", () => {});
  await applyPgMigrations({ connect: async () => client } as unknown as import("pg").Pool, [
    definePgMigration("test/unlock/0001", ["SELECT 1"]),
  ]);
  assert.equal(recorded, true);
  assert.deepEqual(releases, [true]);
  assert.ok(log.mock.calls.some(({ arguments: args }) => String(args[0]).includes("unlock connection reset")));
});
