import "./instrument.ts";
import { loadConfig } from "../config.ts";
import { buildApp, stopWithBackstop } from "../wiring.ts";
import { shutdownOnUncaught } from "../util/process-guard.ts";
import { migrateRegisteredPgSchemas } from "../persistence/pg-pool.ts";
import { bindBootTenant, inBootTenant, readBootTenant } from "../tenants/boot.ts";
import { loadTenant } from "../tenants/cache.ts";

const config = loadConfig();
const built = buildApp(config);
await migrateRegisteredPgSchemas(config.databaseUrl);
const tenant = await bindBootTenant(() => readBootTenant(config.databaseUrl!));
if (config.backgroundWorkEnabled) await inBootTenant(tenant, () => built.ownSharedState());
if (tenant) await inBootTenant(tenant, loadTenant);
const { runtime } = built;
inBootTenant(tenant, () => runtime.start());
console.log(`[qm:worker] draining runs (org=${config.orgId}, workers=${config.workers})`);

let shuttingDown = false;
function shutdown(signal: string, fatal = false): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm:worker] ${signal} received, stopping`);
  stopWithBackstop(runtime, config.shutdownDrainMs, "qm:worker", fatal);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm:worker", shutdown);
