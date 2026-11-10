import { grantAppRole } from "../src/persistence/app-role-grants.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";

const USAGE = "usage: qm db grant <role>";
const [command, role, ...rest] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (command !== "grant" || !role || rest.length) {
  console.error(USAGE);
  process.exit(2);
}
if (!url) {
  console.error("qm db needs DATABASE_URL set to the database owner login");
  process.exit(2);
}
const db = createPgPool(url);
try {
  const schemas = await db.q("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY nspname DESC", [
    ["public", "pgboss"],
  ]);
  for (const { nspname } of schemas) {
    await grantAppRole((text, params) => db.q(text, params), role, String(nspname));
    console.log(`granted ${role} on schema ${String(nspname)}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.close();
}
