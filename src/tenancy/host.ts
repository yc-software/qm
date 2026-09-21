import type { Server } from "node:http";
import { createWorkCapacity } from "../runs/work-capacity.ts";
import { stopWithBackstop } from "../wiring.ts";
import { shutdownOnUncaught } from "../util/process-guard.ts";
import { runWithTenant } from "./context.ts";
import { loadHostConfig, type TenantDefinition } from "./manifest.ts";
import { createHostServer, createTenantRouter } from "./router.ts";
import { prepareTenant, type TenantRuntime } from "./runtime.ts";

export async function startHost(options: { workerOnly?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const host = loadHostConfig(options.env);
  const capacity = createWorkCapacity(host.concurrency);
  const running: { definition: TenantDefinition; runtime: TenantRuntime }[] = [];
  let server: Server | undefined;
  const stopAll = async (action: (runtime: TenantRuntime) => Promise<void>) => {
    const results = await Promise.allSettled(
      running.map(({ definition, runtime }) => runWithTenant(definition.context, () => action(runtime))),
    );
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Tenant host cleanup failed");
  };
  const stop = () => stopAll((runtime) => runtime.stop());
  const releaseInFlightRuns = () => stopAll((runtime) => runtime.releaseInFlightRuns());
  const closeServer = async (): Promise<void> => {
    const current = server;
    if (!current) return;
    await new Promise<void>((resolve, reject) => {
      current.close((error?: Error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      current.closeAllConnections();
    });
  };
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[qm] ${signal} received, draining ${running.length} tenant runtimes`);
    server?.close();
    server?.closeIdleConnections();
    stopWithBackstop(
      { stop, releaseInFlightRuns },
      Math.max(...host.tenants.map(({ config }) => config.shutdownDrainMs)),
      "qm",
      () => server?.closeAllConnections(),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  shutdownOnUncaught("qm", shutdown);
  try {
    for (const definition of host.tenants) {
      const runtime = await prepareTenant(definition.context, definition.config, capacity, options.workerOnly);
      if (shuttingDown) {
        await runWithTenant(definition.context, () => runtime.stop());
        return;
      }
      running.push({ definition, runtime });
    }
    if (!options.workerOnly) {
      server = createHostServer(
        createTenantRouter(
          running.map(({ definition, runtime }) => ({
            context: definition.context,
            hosts: definition.hosts,
            appsDomain: definition.config.deployAppsDomain,
            listener: runtime.listener!,
          })),
          host.pooled,
        ),
      );
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(host.port, () => {
          server!.off("error", reject);
          resolve();
        });
      });
    }
    for (const { definition, runtime } of running) {
      if (shuttingDown) {
        await Promise.all([stop(), closeServer()]);
        return;
      }
      await runWithTenant(definition.context, () => runtime.start());
    }
    console.log(
      `[qm] ${options.workerOnly ? "worker host" : `listening on :${host.port}`} (${host.tenants.length} tenants, ${host.concurrency} shared turn slots)`,
    );
  } catch (error) {
    const cleanup = await Promise.allSettled([stop(), closeServer()]);
    const failures = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], "Tenant host startup failed", { cause: error });
    throw error;
  }
}
