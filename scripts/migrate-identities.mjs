#!/usr/bin/env node
import pg from "pg";
import { ensurePrincipalSchema, runIdentityMigration } from "../src/identity/migrate-identities.ts";

const apply = process.argv.includes("--apply");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await ensurePrincipalSchema(pool);
  const report = await runIdentityMigration({ pool, apply });
  console.log(JSON.stringify(report, null, 2));
  console.log(apply ? "done" : "dry run complete; re-run with --apply to write");
} finally {
  await pool.end();
}
