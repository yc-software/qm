import "./instrument.ts";
import type { Server } from "node:http";
import { stopWithBackstop } from "./wiring.ts";
import { shutdownOnUncaught } from "./util/process-guard.ts";
import { startWebEdge } from "./web-edge.ts";
import { bootApp } from "./boot.ts";
import { createTenantFront } from "./tenants/host.ts";

const servers: Server[] = [];
const booted = await bootApp(process.env, async (server, config) => {
  const listener = config.multitenant ? createTenantFront(server) : server;
  servers.push(listener);
  await new Promise<void>((resolve) => listener.listen(config.port, resolve));
  console.log(
    `[qm] listening on :${config.port} (org=${config.orgId}, ` +
      `workers=${config.workers}, backgroundWork=${config.backgroundWorkEnabled}, multitenant=${config.multitenant})`,
  );
  if (config.publicPort)
    servers.push(
      ...(await startWebEdge(
        { publicPort: config.publicPort, corePort: config.port, orgId: config.orgId },
        process.env,
      )),
    );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  booted.beginShutdown();
  for (const server of servers) {
    server.close();
    server.closeIdleConnections();
  }
  stopWithBackstop(booted, booted.config.shutdownDrainMs, "qm", () => {
    for (const server of servers) server.closeAllConnections();
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm", shutdown);
