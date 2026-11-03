import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { setLoginPasswords } from "./persistence/login-passwords.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
if (!config.databaseUrl || !config.databaseOwnerUrl)
  throw new Error("database migrations need DATABASE_URL and DATABASE_OWNER_URL");
const { runtime } = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  const set = await setLoginPasswords(config.databaseOwnerUrl, config.databaseUrl);
  console.log(
    `[qm:migrate] database migrations applied; ${set.length ? `set the passwords for ${set.join(" and ")}` : "qm_app already accepts its password"}`,
  );
} finally {
  await runtime.stop();
}
