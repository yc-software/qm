import { createPgPool } from "../src/persistence/pg-pool.ts";
import { runTenantCommand, TenantCommandError } from "../src/tenants/operator.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("qm tenant needs DATABASE_URL set to the database owner login");
  process.exit(2);
}
const db = createPgPool(url);
try {
  await runTenantCommand(db, process.argv.slice(2), (line) => console.log(line));
} catch (e) {
  console.error(e instanceof TenantCommandError ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.close();
}
