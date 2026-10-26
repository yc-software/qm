import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPgPool, definePgMigration, pgMigration, pgMigrationChecksum } from "../src/persistence/pg-pool.ts";

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

test("migration definitions reject invalid ids", () => {
  assert.throws(() => definePgMigration("../bad", ["SELECT 1"]), /migration id/);
});

test("declaring statements as concurrent indexes keeps the checksum of the same statements", () => {
  const statement = "CREATE INDEX CONCURRENTLY IF NOT EXISTS session_search ON sessions(id)";
  const declared = pgMigration({
    id: "test/indexes/0001",
    concurrentIndexes: [{ name: "session_search", table: "sessions", statement }],
  });
  assert.equal(declared.checksum, definePgMigration("test/indexes/0001", [statement]).checksum);
});

function pathToUrl(p: string): string {
  return new URL(`file://${p}`).href;
}
