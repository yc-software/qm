import pg from "pg";
import { verifyTranscriptAttributes } from "./lib/transcript-tape-migration.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
createPostgresSessionStore(url);
console.log(JSON.stringify({ event: "transcript-cutover-start" }));
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
await client.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const entries = await verifyTranscriptAttributes(client);
  await client.query("COMMIT");
  console.log(JSON.stringify({ event: "transcript-metadata-qualified", entries }));
} finally {
  await client.end();
}
await migrateRegisteredPgSchemas(url);
console.log(JSON.stringify({ event: "transcript-cutover-qualified" }));
