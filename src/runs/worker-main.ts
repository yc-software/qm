import "./instrument.ts";
import { loadConfig } from "../config.ts";
import { buildApp, stopWithBackstop } from "../wiring.ts";
import { shutdownOnUncaught } from "../util/process-guard.ts";
import { reportFailureAs } from "../util/errors.ts";
import { migrateRegisteredPgSchemas } from "../persistence/pg-pool.ts";
import { migrateTenantStorageOnce } from "../tenants/storage-migration.ts";

const config = loadConfig();
const built = buildApp(config);
await migrateRegisteredPgSchemas(config.databaseUrl);
await migrateTenantStorageOnce(config);
await built.tenantSettings.refreshAll();
await built.boot();
const { runtime } = built;
runtime.start();
console.log(`[qm:worker] draining runs (runStore=${config.runStore}, workers=${config.workers})`);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm:worker] ${signal} received, stopping`);
  stopWithBackstop(runtime, config.shutdownDrainMs, "qm:worker");
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm:worker", shutdown);
