import { loadConfig } from "../config.ts";
import { migrateRegisteredPgSchemas } from "../persistence/pg-pool.ts";
import { scopeId } from "../types.ts";
import { buildApp } from "../wiring.ts";
import { withTenant } from "./context.ts";
import { instanceTenant } from "./instance.ts";
import { importTenantSettings, tenantImportKeys } from "./settings-import.ts";

const config = loadConfig();
const built = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  const tenant = await instanceTenant(config);
  if (!tenant) throw new Error("Importing tenant settings needs SESSION_STORE=postgres and DATABASE_URL");
  const values = Object.fromEntries(
    tenantImportKeys().flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
  );
  const updated = await withTenant(tenant, () =>
    importTenantSettings(values, {
      settings: built.tenantSettings,
      modelCredentials: built.modelCredentials,
      config: built.config,
      rootScope: scopeId("org", config.orgId),
      actor: "tenant settings import",
    }),
  );
  console.log(`[qm:tenant-settings] imported ${updated.length ? updated.join(", ") : "nothing"} into tenant ${tenant}`);
} finally {
  await built.runtime.stop();
}
