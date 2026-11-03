import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { appLoginName, ensureAppLogin, type AppLoginChange } from "./persistence/app-login.ts";
import { buildApp } from "./wiring.ts";

const CHANGE_NOTE: Record<AppLoginChange, (login: string) => string> = {
  created: (login) => `created the login ${login}`,
  "password set": (login) => `set the password for ${login}`,
  unchanged: (login) => `${login} already accepts its password`,
};

const config = loadConfig();
if (!config.databaseUrl || !config.databaseOwnerUrl)
  throw new Error("database migrations need DATABASE_URL and DATABASE_OWNER_URL");
const { runtime } = buildApp(config);
try {
  const change = await ensureAppLogin(config.databaseOwnerUrl, config.databaseUrl);
  await migrateRegisteredPgSchemas(config.databaseUrl);
  const login = appLoginName(config.databaseOwnerUrl, config.databaseUrl);
  console.log(`[qm:migrate] ${CHANGE_NOTE[change](login)}; database migrations applied`);
} finally {
  await runtime.stop();
}
