import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPgPool, concurrentIndexName, pgMigrationChecksum } from "../src/persistence/pg-pool.ts";

test("createPgPool is lazy: building it neither connects nor throws (no DB needed)", async () => {
  const pg = createPgPool("postgres://does-not-exist:0/none");
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
    const p = createPgPool("postgres://x/y", [{ id: "test/invalid/0001", statements: ["SELECT 1"] }]);
    await p.close();
    console.log("OK");
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.match(out, /OK/);
});

test("migration checksums are stable and sensitive to statement changes", () => {
  assert.equal(pgMigrationChecksum([" SELECT 1 ", "SELECT 2;"]), pgMigrationChecksum(["SELECT 1", "SELECT 2;"]));
  assert.notEqual(pgMigrationChecksum(["SELECT 1"]), pgMigrationChecksum(["SELECT 2"]));
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
