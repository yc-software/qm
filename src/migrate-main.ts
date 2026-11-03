import pg from "pg";
import { loadConfig } from "./config.ts";
import { installCronQueueSchema } from "./cron/job-queue.ts";
import { migrateRegisteredPgSchemas, pgConnectionOptions, withPgTransaction } from "./persistence/pg-pool.ts";
import { appLoginName, ensureAppLogin } from "./persistence/app-login.ts";
import { grantAppLogin } from "./tenants/logins.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const { databaseUrl, databaseOwnerUrl } = config;
if (!databaseUrl || !databaseOwnerUrl) throw new Error("database migrations need DATABASE_URL and DATABASE_OWNER_URL");
const { runtime } = buildApp({ ...config, databaseUrl: databaseOwnerUrl, databasePoolUrl: undefined });
const owner = new pg.Pool(pgConnectionOptions(databaseOwnerUrl));
try {
  const change = await ensureAppLogin(databaseOwnerUrl, databaseUrl);
  await migrateRegisteredPgSchemas(databaseOwnerUrl);
  await installCronQueueSchema(databaseOwnerUrl);
  await withPgTransaction(owner, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('qm:grant-app-login'))");
    await grantAppLogin(client, databaseUrl);
  });
  const login = appLoginName(databaseOwnerUrl, databaseUrl);
  console.log(
    `[qm:migrate] ${change === "created" ? "created" : "found"} the login ${login}; database migrations applied and access granted`,
  );
} finally {
  await owner.end();
  await runtime.stop();
}
