import { loadConfig } from "../config.ts";
import { buildApp, stopWithBackstop } from "../wiring.ts";

const config = loadConfig();
const built = buildApp(config);
await built.config.hydrate?.();
await built.identity.hydrate();
const { runtime } = built;
runtime.start();
console.log(`[qm:worker] draining runs (org=${config.orgId}, runStore=${config.runStore}, workers=${config.workers})`);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm:worker] ${signal} received, stopping`);
  stopWithBackstop(runtime, config.shutdownDrainMs, "qm:worker");
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
