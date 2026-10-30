import "../instrument.ts";
import { createServer } from "node:http";
import { loadConfig } from "../config.ts";
import { buildCore, stopWithBackstop } from "../wiring.ts";
import { buildHarness } from "./build.ts";
import { createBackgroundController } from "../runs/background-controller.ts";
import { shutdownOnUncaught } from "../util/process-guard.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";
import { migrateRegisteredPgSchemas } from "../persistence/pg-pool.ts";
import { withTimeout } from "../util/async.ts";

const config = loadConfig();

const core = buildCore(config);
const harness = buildHarness(config, core);
await migrateRegisteredPgSchemas(config.databaseUrl);
await core.sandboxResources.initialize();
const backfilledFires = await core.crons.backfillFires();
if (backfilledFires > 0) console.log(`[qm] backfilled ${backfilledFires} cron fire log entries into cron_fires`);

await core.config.hydrate?.();
await core.refreshCustomProviders();
await core.identity.refresh();
await core.deploymentLayerReady;
core.deploymentLayerRefresh.start();
harness.runtime.start();

const server = createServer((req, res) => {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/healthz") return reply(200, { ok: true });
  if (req.url !== "/readyz") return reply(404, { error: "not_found" });
  const controller = new AbortController();
  void withTimeout(() => core.checkReadiness(controller.signal), 1_000, "readiness")
    .then(
      () => reply(200, { ok: true }),
      () => reply(503, { ok: false }),
    )
    .finally(() => controller.abort());
});
server.listen(config.port, () => {
  console.log(
    `[qm] harness listening on :${config.port} (org=${config.orgId}, ` +
      `workers=${config.workers}, backgroundWork=${config.backgroundWorkEnabled})`,
  );
});

if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) {
  await harness.jobs.start();
} else if (!config.backgroundDeploymentId) {
  console.log("[qm] background work disabled; scheduler and runtime loops will not start");
}

let backgroundController: ReturnType<typeof createBackgroundController> | undefined;
if (core.backgroundOwnership) {
  let periodicStop: Promise<void> = Promise.resolve();
  let activationEpoch = 0;
  backgroundController = createBackgroundController({
    store: core.backgroundOwnership.store,
    deploymentId: core.backgroundOwnership.deploymentId,
    async start(signal) {
      const epoch = ++activationEpoch;
      if (signal.aborted) return;
      harness.runtime.startBackground();
      await periodicStop;
      if (signal.aborted || epoch !== activationEpoch) return;
      await harness.jobs.start();
    },
    fence() {
      activationEpoch++;
      periodicStop = harness.jobs.stopClaims();
      void periodicStop.catch((error) => console.error("[qm] periodic background stop failed:", errMessage(error)));
      void harness.runtime
        .stopBackgroundClaims()
        .catch((error) => console.error("[qm] background claim stop failed:", errMessage(error)));
    },
    async relinquish() {
      await Promise.all([harness.runtime.stopBackgroundClaims(), harness.jobs.stopClaims()]);
    },
    async drained() {
      await Promise.all([harness.runtime.backgroundDrained(), harness.jobs.drained(), periodicStop]);
    },
    onError: reportFailureAs("background ownership", undefined),
  });
  harness.runtime.setBackgroundAdmission(backgroundController.canClaim, backgroundController.active);
  backgroundController.start();
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  void harness.jobs.stop().catch((e: unknown) => console.error("[qm] job worker stop failed:", errMessage(e)));
  core.deploymentLayerRefresh.stop();
  server.close();
  server.closeIdleConnections();
  stopWithBackstop(
    {
      async stop() {
        await backgroundController?.stop();
        await harness.runtime.stop();
      },
      releaseInFlightRuns: () => harness.runtime.releaseInFlightRuns(),
    },
    config.shutdownDrainMs,
    "qm",
    () => server.closeAllConnections(),
  );
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm", shutdown);
