import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildApp } from "./wiring.ts";
import { adoptEnvironmentSlack, slackWorkspaceOf } from "./slack/environment-install.ts";
import { useOwnerDatabase } from "./tenants/claim.ts";

const config = loadConfig();
useOwnerDatabase(config.databaseOwnerUrl);
const { runtime, slackInstallation } = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  console.log("[qm:migrate] database migrations applied");
  const adopted = await adoptEnvironmentSlack({
    environment: config.slack,
    installation: slackInstallation,
    workspaceOf: slackWorkspaceOf(config.slack?.apiUrl),
  });
  if (adopted) console.log(`[qm:migrate] stored the environment's Slack installation for tenant ${adopted}`);
} finally {
  await runtime.stop();
}
