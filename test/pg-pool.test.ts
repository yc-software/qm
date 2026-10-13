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
  waitForPgDatabase,
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

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

test("waitForPgDatabase retries transient connect failures and logs once while waiting", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => logged.push(line));
  const failures = [
    ...["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].map(
      pgError,
    ),
    ...["53300", "57P01", "57P02", "57P03"].map(pgError),
    new Error("Connection terminated unexpectedly"),
    new Error("Connection terminated due to connection timeout"),
    new Error("timeout exceeded when trying to connect"),
  ];
  const attempts = failures.length + 1;
  const calls: unknown[][] = [];
  await waitForPgDatabase(
    { databaseUrl: "postgres://db/qm" },
    {
      intervalMs: 1,
      probe: async (...args) => {
        calls.push(args);
        const failure = failures.shift();
        if (failure) throw failure;
      },
    },
  );
  assert.equal(calls.length, attempts);
  assert.deepEqual(calls[0], ["postgres://db/qm", {}]);
  assert.deepEqual(logged, ["[pg] waiting up to 180s for the database to accept connections (ECONNREFUSED)"]);
});

test("waitForPgDatabase fails immediately on a non-transient error", async (t) => {
  t.mock.method(console, "log", () => {});
  let calls = 0;
  await assert.rejects(
    waitForPgDatabase(
      { databaseUrl: "postgres://db/qm" },
      {
        intervalMs: 1,
        probe: async () => {
          calls++;
          throw pgError("28P01");
        },
      },
    ),
    /pg 28P01/,
  );
  assert.equal(calls, 1);
});

test("waitForPgDatabase throws the last transient error once the deadline passes", async (t) => {
  t.mock.method(console, "log", () => {});
  let calls = 0;
  await assert.rejects(
    waitForPgDatabase(
      { databaseUrl: "postgres://db/qm" },
      {
        deadlineMs: 20,
        intervalMs: 1,
        probe: async () => {
          calls++;
          throw pgError(calls === 1 ? "ENOTFOUND" : "ECONNREFUSED");
        },
      },
    ),
    /pg ECONNREFUSED/,
  );
  assert.ok(calls > 1);
});

test("waitForPgDatabase skips the probe without a database URL", async () => {
  let calls = 0;
  await waitForPgDatabase(
    {},
    {
      probe: async () => {
        calls++;
      },
    },
  );
  assert.equal(calls, 0);
});

test("waitForPgDatabase probes with the configured database CA", async () => {
  const seen: unknown[] = [];
  await waitForPgDatabase(
    { databaseUrl: "postgres://db/qm", databaseCaCert: "PEM" },
    {
      probe: async (_url, caTrust) => {
        seen.push(caTrust);
      },
    },
  );
  assert.deepEqual(seen, [{ ssl: { ca: "PEM" } }]);
});

function pathToUrl(p: string): string {
  return new URL(`file://${p}`).href;
}
