import "./instrument.ts";
import { loadConfig } from "./config.ts";
import { startQm } from "./start.ts";
import { stopWithBackstop } from "./wiring.ts";
import { logEventLoopLag } from "./util/event-loop-lag.ts";
import { shutdownOnUncaught } from "./util/process-guard.ts";

const config = loadConfig();
const qm = await startQm(config, { env: process.env });
logEventLoopLag();

let shuttingDown = false;
function shutdown(signal: string, fatal = false): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  stopWithBackstop(qm, config.shutdownDrainMs, "qm", fatal);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm", shutdown);
