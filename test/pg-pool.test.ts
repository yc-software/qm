import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPgPool, assertOneStatement, concurrentIndexName } from "../src/persistence/pg-pool.ts";

test("createPgPool is lazy: building it neither connects nor throws (no DB needed)", async () => {
  const pg = createPgPool("postgres://does-not-exist:0/none", ["SELECT 1"]);
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
    const p = createPgPool("postgres://x/y", ["SELECT 1"]);
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
