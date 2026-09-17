import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { transcriptPayloadMigration } from "../src/sessions/transcript-schema.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
try {
  await applyPgMigrations(pool, [
    definePgMigration(transcriptPayloadMigration.id, transcriptPayloadMigration.statements),
  ]);
  console.log(JSON.stringify({ event: "transcript-payload-format-prepared", id: transcriptPayloadMigration.id }));
} finally {
  await pool.end();
}
