import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createPgPool,
  configurePgPoolLimits,
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

test("stores using one database share a bounded pool without sharing close ownership", async () => {
  const stores = Array.from({ length: 32 }, () => createPgPool("postgres://unused@127.0.0.1:1/shared"));
  try {
    const pools = await Promise.all(stores.map((store) => store.pool()));
    assert.equal(new Set(pools).size, 1);
    await stores[0]!.close();
    assert.equal(await stores[1]!.pool(), pools[0]);
    assert.equal(pools[0]!.ending, false);
  } finally {
    await Promise.all(stores.map((store) => store.close()));
  }
});

test("query and session budgets are separate, shared by purpose, and release once", async () => {
  const url = "postgres://unused@127.0.0.1:1/budgets";
  const a = createPgPool(url);
  const b = createPgPool(url);
  const other = createPgPool(url + "-other");
  try {
    const query = await a.pool();
    const session = await a.pool("session");
    assert.notEqual(query, session);
    assert.equal(await b.pool("session"), session);
    assert.notEqual(await other.pool(), query);
    assert.equal(query.options.max, 8);
    assert.equal(session.options.max, 4);
    const coordination = await a.pool("coordination");
    assert.notEqual(coordination, session);
    assert.notEqual(coordination, query);
    assert.equal(coordination.options.max, 4);
    assert.equal(await b.pool("coordination"), coordination);
    assert.equal(query.options.connectionTimeoutMillis, 5_000);
    await Promise.all([a.close(), a.close()]);
    assert.equal(query.ending, false);
    assert.equal(session.ending, false);
    assert.equal(coordination.ending, false);
    await b.close();
    assert.equal(query.ended, true);
    assert.equal(session.ended, true);
    assert.equal(coordination.ended, true);
    await assert.rejects(a.pool(), /closed/);
    const replacement = createPgPool(url);
    try {
      assert.notEqual(await replacement.pool(), query);
    } finally {
      await replacement.close();
    }
  } finally {
    await Promise.all([a.close(), b.close(), other.close()]);
  }
});

test("pool budgets reject invalid limits instead of creating unbounded pools", async () => {
  try {
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => configurePgPoolLimits({ query: limit, session: 8 }), /positive integers/);
      assert.throws(() => configurePgPoolLimits({ query: 8, session: limit }), /positive integers/);
    }
    configurePgPoolLimits({ query: 2, session: 3 });
    const store = createPgPool("postgres://unused@127.0.0.1:1/valid");
    try {
      assert.equal((await store.pool()).options.max, 2);
      assert.equal((await store.pool("session")).options.max, 3);
      assert.equal(await store.pool("coordination"), await store.pool("session"));
    } finally {
      await store.close();
    }
  } finally {
    configurePgPoolLimits({ query: 8, session: 8 });
  }
});

test("coordination reserve stays within the configured session budget", async () => {
  try {
    for (const session of [5, 8, 16]) {
      configurePgPoolLimits({ query: 8, session });
      const pg = createPgPool(`postgres://unused@127.0.0.1:1/reserve-${session}`);
      try {
        const operations = await pg.pool("session");
        const coordination = await pg.pool("coordination");
        assert.ok(operations.options.max! >= 1);
        assert.equal(coordination.options.max, 4);
        assert.equal(operations.options.max! + coordination.options.max!, session);
      } finally {
        await pg.close();
      }
    }
  } finally {
    configurePgPoolLimits({ query: 8, session: 8 });
  }
});

test("small budgets preserve one shared session pool and close ownership", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  try {
    for (const session of [1, 2, 3, 4]) {
      configurePgPoolLimits({ query: 8, session });
      assert.equal(warning.mock.callCount(), session);
      assert.match(String(warning.mock.calls.at(-1)!.arguments[0]), /configured budget is unchanged/);
      const a = createPgPool(`postgres://unused@127.0.0.1:1/small-${session}`);
      const b = createPgPool(`postgres://unused@127.0.0.1:1/small-${session}`);
      try {
        const operations = await a.pool("session");
        const coordination = await a.pool("coordination");
        assert.equal(coordination, operations);
        assert.equal(await b.pool("coordination"), operations);
        assert.equal(operations.options.max, session);
        assert.notEqual(await a.pool(), operations);
        await a.close();
        assert.equal(operations.ending, false);
        await b.close();
        assert.equal(operations.ended, true);
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    }
  } finally {
    configurePgPoolLimits({ query: 8, session: 8 });
  }
});
