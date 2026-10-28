import type { WorkersModule } from "./workers.ts";
import type { StoresModule } from "./stores.ts";
import type { MemoryModule } from "./memory.ts";
import type { FilesModule } from "./files.ts";
import type { RunsModule } from "./runs.ts";
import type { HarnessModule } from "./harness.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { Head } from "./late.ts";
import { swallowAs, reportFailureAs } from "../util/errors.ts";
import { withTimeout } from "../util/async.ts";
import type { Runtime } from "../wiring.ts";

type BackgroundInputs = Pick<Head, "admittedWork" | "gates" | "config"> & {
  workers: WorkersModule;
  stores: StoresModule;
  memory: MemoryModule;
  files: FilesModule;
  runs: RunsModule;
  harness: HarnessModule;
  deploymentLayer: DeploymentLayerModule;
};

export function buildBackground(deps: BackgroundInputs) {
  const { admittedWork, gates, config } = deps;
  const { drain, turnRunner } = deps.workers;
  const { jobs } = deps.stores;
  const { semanticMemory } = deps.memory;
  const { blobTransfer } = deps.files;

  let backgroundRunning = false;
  let backgroundStopping: Promise<void> | null = null;
  let backgroundClaimsStopping: Promise<void> = Promise.resolve();
  let backgroundGeneration = 0;
  function startBackground(): void {
    if (backgroundRunning) return;
    backgroundRunning = true;
    admittedWork.resume();
    drain.start();
    const generation = ++backgroundGeneration;
    turnRunner.start();
    const startPeriodic = () => {
      if (!backgroundRunning || generation !== backgroundGeneration) return;
      void jobs
        .start()
        .catch(reportFailureAs("jobs: start (background jobs will not run from this process)", undefined));
    };
    if (backgroundStopping)
      void backgroundClaimsStopping.then(startPeriodic).catch(swallowAs("wiring: periodic resume failed", undefined));
    else startPeriodic();
  }
  function stopBackground(): Promise<void> {
    admittedWork.pause();
    backgroundRunning = false;
    const previous = backgroundStopping;
    backgroundGeneration++;
    void semanticMemory.stop();
    const stopping = [jobs.stopClaims(), turnRunner.stopClaims()];
    backgroundClaimsStopping = Promise.all(stopping).then(() => {});
    const draining = Promise.all([previous, backgroundClaimsStopping])
      .then(() => {})
      .finally(() => {
        if (backgroundStopping === draining) backgroundStopping = null;
      });
    backgroundStopping = draining;
    return draining;
  }
  async function releaseInFlightRuns(): Promise<void> {
    gates.inlineShutdown.abort();
    await Promise.all([
      withTimeout(() => admittedWork.drained(), 3_000, "inline turn handback").catch(
        swallowAs("wiring: inline turn handback failed", undefined),
      ),
      turnRunner.releaseInFlight(),
    ]);
  }
  const runtime: Runtime = {
    start() {
      if (gates.inlineShutdown.signal.aborted) gates.inlineShutdown = new AbortController();
      void blobTransfer
        .ensureExpiry?.(1)
        .catch(reportFailureAs("blob-transfer: S3 lifecycle expiry install (sweep is the fallback)", undefined));
      drain.start();
      if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) startBackground();
    },
    startTurns() {
      if (!gates.inlineShutdown.signal.aborted) turnRunner.start();
    },
    startBackground,
    setBackgroundAdmission(canClaim, active) {
      gates.backgroundAdmission = canClaim;
      gates.backgroundActive = active;
    },
    async stopBackgroundClaims() {
      void stopBackground().catch(swallowAs("wiring: background drain failed", undefined));
      await backgroundClaimsStopping;
    },
    stopBackground,
    async backgroundDrained() {
      await backgroundStopping;
      await Promise.all([admittedWork.drained(), jobs.stop()]);
    },
    releaseInFlightRuns,
    async stop() {
      await turnRunner.releaseInFlight();
      await stopBackground();
      await Promise.all([
        withTimeout(() => admittedWork.drained(), config.shutdownDrainMs, "admitted work drain").catch(
          swallowAs("wiring: admitted work drain failed", undefined),
        ),
        withTimeout(() => jobs.stop(), config.shutdownDrainMs, "background job drain"),
      ]).catch(swallowAs("wiring: background drain failed", undefined));
      await releaseInFlightRuns();
      await drain.stop();
      await closeEventStores(deps);
    },
  };
  return { runtime };
}

export type BackgroundModule = ReturnType<typeof buildBackground>;

async function closeEventStores(deps: BackgroundInputs): Promise<void> {
  const { semanticMemory } = deps.memory;
  const {
    stopStreamSync,
    runs,
    turnLedger,
    contextRequestEvents,
    sessionStateBus,
    ledgerEventBus,
    runActivity,
    runStreamEvents,
  } = deps.runs;
  const { runSignals, customProvidersChanged } = deps.harness;
  const { turnReady, turnCancels, turnYields } = deps.workers;
  const { deploymentLayerChanged } = deps.deploymentLayer;
  const { errors } = deps.files;
  stopStreamSync();
  await Promise.all(
    [
      runs.close?.(),
      runSignals.close?.(),
      turnLedger.close(),
      turnReady.close?.(),
      contextRequestEvents.close?.(),
      turnCancels.close?.(),
      turnYields.close?.(),
      sessionStateBus.close?.(),
      ledgerEventBus.close?.(),
      deploymentLayerChanged.close?.(),
      customProvidersChanged.close?.(),
      runActivity.close?.(),
      runStreamEvents.close?.(),
    ].map((closing) => closing?.catch(reportFailureAs("shutdown: close event stores", undefined))),
  );
  await semanticMemory.close();
  await errors.flush();
}
