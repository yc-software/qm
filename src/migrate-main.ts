import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { appLoginName, ensureAppLogin } from "./persistence/app-login.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const { databaseUrl, databaseOwnerUrl } = config;
if (!databaseUrl || !databaseOwnerUrl) throw new Error("database migrations need DATABASE_URL and DATABASE_OWNER_URL");
const { runtime } = buildApp({ ...config, databaseUrl: databaseOwnerUrl, databasePoolUrl: undefined });
try {
  const change = await ensureAppLogin(databaseOwnerUrl, databaseUrl);
  await migrateRegisteredPgSchemas(databaseOwnerUrl);
  const login = appLoginName(databaseOwnerUrl, databaseUrl);
  console.log(
    `[qm:migrate] ${change === "created" ? "created" : "found"} the login ${login}; database migrations applied`,
  );
} finally {
  await runtime.stop();
}
