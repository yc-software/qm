import type { StoresModule } from "./stores.ts";
import type { RunsModule } from "./runs.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { FilesModule } from "./files.ts";
import type { SandboxModule } from "./sandbox.ts";
import type { ReceiversModule } from "./receivers.ts";
import type { Head } from "./late.ts";
import { type BackgroundOwnershipControl, createBackgroundOwnershipStore } from "../runs/background-ownership.ts";
import { randomUUID } from "node:crypto";
import {
  type InstanceRegistry,
  createPostgresInstanceRegistry,
  createNoopInstanceRegistry,
} from "../runs/instance-registry.ts";
import { type DrainController, createDrainController } from "../runs/drain.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { TURN_READY_CHANNEL, TURN_CANCEL_CHANNEL, TURN_YIELD_CHANNEL } from "../turns/turn-ledger.ts";
import { createTurnRunner, RUN_MAX_CLAIMS } from "../turns/turn-runner.ts";
import { tenantTurnRunners } from "../tenants/fan-out.ts";
import { TURN_QUEUES } from "../turns/absurd-schema.ts";
import {
  type ProcessReaper,
  createProcessReaper,
  createReaperKillHook,
  PROCESS_REAPER_INTERVAL_MS,
} from "../processes/process-reaper.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import { createJobComputerSweep } from "../processes/job-computers.ts";
import { errMessage } from "../util/errors.ts";
import { createComposioReturns } from "../connectors/composio-links.ts";

type WorkersInputs = Pick<Head, "config" | "gates" | "late"> & {
  stores: StoresModule;
  runs: RunsModule;
  orchestrator: OrchestratorModule;
  files: FilesModule;
  sandbox: SandboxModule;
  receivers: ReceiversModule;
};

export function buildWorkers(deps: WorkersInputs) {
  const { config, gates, late } = deps;
  const { pgPool, databaseUrl, every } = deps.stores;
  const { turnLedger, processes } = deps.runs;
  const { orchestrator } = deps.orchestrator;
  const { errors } = deps.files;
  const { sandbox, sandboxResources } = deps.sandbox;
  const { finishCredentials } = deps.receivers;

  const backgroundOwnership: BackgroundOwnershipControl | undefined = config.backgroundDeploymentId
    ? {
        store: createBackgroundOwnershipStore(databaseUrl),
        instanceId: randomUUID(),
        deploymentId: config.backgroundDeploymentId,
        active: () => gates.backgroundActive(),
      }
    : undefined;
  const instanceRegistry: InstanceRegistry =
    !backgroundOwnership && config.buildSha && config.backgroundWorkEnabled
      ? createPostgresInstanceRegistry(pgPool, {
          instanceId: randomUUID(),
          buildSha: config.buildSha,
          startedAt: Date.now(),
        })
      : createNoopInstanceRegistry();
  const drain: DrainController = createDrainController({ registry: instanceRegistry });
  const canClaimRuns = () => gates.backgroundAdmission() && drain.canClaim();
  const turnReady = createPostgresNotifyBus<string>(databaseUrl, TURN_READY_CHANNEL, "turn readiness");
  const turnCancels = createPostgresNotifyBus<string>(databaseUrl, TURN_CANCEL_CHANNEL, "turn cancels");
  const turnYields = createPostgresNotifyBus<string>(databaseUrl, TURN_YIELD_CHANNEL, "turn yields");
  const turnRunner = tenantTurnRunners(() =>
    createTurnRunner({
      ledger: turnLedger,
      orchestrator,
      queues: TURN_QUEUES,
      slots: Math.max(1, config.workers),
      ready: turnReady,
      cancels: turnCancels,
      yields: turnYields,
      canClaim: canClaimRuns,
      errors,
      maxClaims: RUN_MAX_CLAIMS,
    }),
  );
  late.turnRunner = turnRunner;
  const processReaper: ProcessReaper | null = processes
    ? createProcessReaper(processes, {
        ...(supportsProcessSessions(sandbox)
          ? {
              kill: createReaperKillHook(sandbox, { onExit: finishCredentials }),
              afterSweep: createJobComputerSweep({
                resources: sandboxResources,
                sandbox,
                processes,
                finish: finishCredentials,
                onError: (error, scopeId) =>
                  errors.record(
                    {
                      category: "process_session",
                      code: "job_computer_retire_failed",
                      message: errMessage(error),
                      scopeLabel: scopeId,
                    },
                    error,
                  ),
              }),
            }
          : {}),
      })
    : null;
  const composioReturns = createComposioReturns(databaseUrl);
  const deepIdleMachineMs = 3 * 24 * 60 * 60_000;
  const devIdleMachineMs = 2 * 60 * 60_000;
  const reapDeepIdle = deepIdleMachineMs > 0 || devIdleMachineMs > 0 ? sandbox.reapDeepIdle : undefined;
  if (processReaper) every("processes:reaper", PROCESS_REAPER_INTERVAL_MS, () => processReaper.sweep());
  every("Composio consent returns", 30 * 60_000, () => composioReturns.deleteExpired(Date.now()), {
    immediate: true,
  });
  if (reapDeepIdle)
    every("sandbox:deep-idle-reaper", 5 * 60_000, () => reapDeepIdle(deepIdleMachineMs, devIdleMachineMs), {
      immediate: true,
    });
  return { composioReturns, drain, turnRunner, turnReady, turnCancels, turnYields, backgroundOwnership };
}

export type WorkersModule = ReturnType<typeof buildWorkers>;
