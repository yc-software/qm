import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { applyPgMigrations, dbMigrations, PG_MIGRATIONS_TABLE } from "../src/persistence/pg-pool.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "npm run db:schema needs DATABASE_URL set to a Postgres login that can create databases; PG_DUMP may name a pg_dump command matching the server's major version",
  );
  process.exit(2);
}
const name = `qm_schema_${randomUUID().replaceAll("-", "")}`;
const scratch = new URL(url);
scratch.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`);
const keepFailure = (error: unknown, message: string) => (cleanupError: unknown) => {
  throw new AggregateError([error, cleanupError], message);
};
const dropScratch = async () => {
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
};
try {
  const pool = new pg.Pool({ connectionString: scratch.toString(), max: 1 });
  const ledger = await applyPgMigrations(pool, dbMigrations({ schema: false }))
    .then(() =>
      pool.query<{ id: string; checksum: string }>(`SELECT id, checksum FROM ${PG_MIGRATIONS_TABLE} ORDER BY id`),
    )
    .then(
      async (result) => {
        await pool.end();
        return result;
      },
      async (error: unknown) => {
        await pool
          .end()
          .catch(keepFailure(error, "migrating the scratch database failed, then closing its pool failed"));
        throw error;
      },
    );
  const [command, ...args] = (process.env.PG_DUMP ?? "pg_dump").split(" ");
  const dump = execFileSync(
    command!,
    [
      ...args,
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--exclude-schema=pgboss",
      `--exclude-table=${PG_MIGRATIONS_TABLE}`,
      `--dbname=${scratch.toString()}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const lines: string[] = [];
  for (const line of dump.split("\n")) {
    if (line.startsWith("--") || line.startsWith("\\restrict") || line.startsWith("\\unrestrict")) continue;
    if (line.startsWith("COMMENT ON EXTENSION ")) continue;
    if (line === "SELECT pg_catalog.set_config('search_path', '', false);") continue;
    if (line === "" && (lines.length === 0 || lines.at(-1) === "")) continue;
    lines.push(line.startsWith("SET ") ? `SET LOCAL ${line.slice(4)}` : line);
  }
  while (lines.at(-1) === "") lines.pop();
  lines.push("", "INSERT INTO public.tenants DEFAULT VALUES;");
  for (const row of ledger.rows)
    lines.push(
      `INSERT INTO public.${PG_MIGRATIONS_TABLE}(id, checksum) VALUES (${admin.escapeLiteral(row.id)}, ${admin.escapeLiteral(row.checksum)});`,
    );
  writeFileSync(new URL("../db/schema.sql", import.meta.url), `${lines.join("\n")}\n`);
  console.log(`wrote db/schema.sql (${ledger.rows.length} migrations folded in)`);
} catch (error) {
  await dropScratch().catch(keepFailure(error, `db:schema failed, then dropping scratch database ${name} failed`));
  throw error;
}
await dropScratch();
