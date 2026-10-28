import type { MemoryModule } from "./memory.ts";
import { hasRows } from "../jobs/job-worker.ts";
import type { CronsModule } from "./crons.ts";
import type { StoresModule } from "./stores.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { HarnessModule } from "./harness.ts";
import type { Head } from "./late.ts";
import { createSuggestedActivityProfileStore, createSuggestedActivityService } from "../suggestions/activities.ts";
import { createMemoryTidyProfileStore, createMemoryTidyService } from "../memory/tidy.ts";
import { createScheduler } from "../cron/scheduler.ts";
import { createControlService } from "../api/control-service.ts";
import { availableRuntimeError } from "../api/runtime-config.ts";
import { providerKeysPresent } from "../config.ts";
import { createRuntimeService } from "../harness/runtime-control.ts";

type SchedulerInputs = Pick<Head, "late" | "admittedWork" | "config" | "overrides"> & {
  memory: MemoryModule;
  crons: CronsModule;
  stores: StoresModule;
  apiApp: ApiAppModule;
  orchestrator: OrchestratorModule;
  harness: HarnessModule;
};

export function buildScheduler(deps: SchedulerInputs) {
  const { baseMemory } = deps.memory;
  const { crons } = deps.crons;
  const { late, admittedWork, config, overrides } = deps;
  const { databaseUrl, advisoryLock, sessions, admin, configStore, every, jobs } = deps.stores;
  const { app, triggerDeps, sweepAsks } = deps.apiApp;
  const { orchestratorDeps } = deps.orchestrator;
  const { fallback, modelCredentials, refreshModels } = deps.harness;

  const suggestedActivityProfiles = createSuggestedActivityProfileStore(databaseUrl);
  const memoryTidy = createMemoryTidyService({
    store: createMemoryTidyProfileStore(databaseUrl),
    memory: baseMemory,
    timezone: async (principalId) => (await suggestedActivityProfiles.get(principalId))?.timezone,
    crons,
    scheduler: { notifyChanged: (id) => scheduler.notifyChanged(id) },
  });
  late.memoryTidy = memoryTidy;
  const scheduler = createScheduler({
    admittedWork,
    skipFire: async (cron) => (await memoryTidy.skipFire(cron)) ?? suggestedActivities.skipFire(cron),
    deleteCron: (id) => app.deleteCron(id),
    advisoryLock,
    crons,
    ...triggerDeps,
    jobs,
    fireConcurrency: config.cronFireConcurrency,
  });
  late.scheduler = scheduler;
  const suggestedActivities = createSuggestedActivityService({
    store: suggestedActivityProfiles,
    sessions,
    crons,
    scheduler,
    enabled: config.suggestedActivitiesEnabled === true,
    ...(config.suggestedActivitiesContext ? { context: config.suggestedActivitiesContext } : {}),
  });
  orchestratorDeps.control = createControlService(app, scheduler, admin);
  orchestratorDeps.validateScheduledRuntime = (scope, choice, purpose) =>
    availableRuntimeError(
      {
        deps: {
          config: configStore,
          baseModelDefault: fallback.modelId,
          providerKeys: providerKeysPresent(config),
          modelCredentials,
          modelCredentialFetch: overrides.modelCredentialFetch,
          refreshModels,
        },
      },
      scope,
      choice,
      purpose,
    );
  orchestratorDeps.runtime = createRuntimeService(
    {
      config: configStore,
      get baseModelDefault() {
        return fallback.modelId;
      },
      providerKeys: providerKeysPresent(config),
      modelCredentials,
      modelCredentialFetch: overrides.modelCredentialFetch,
      refreshModels,
    },
    app,
  );
  every("cron:repair", 60_000, () => scheduler.repair(), {
    immediate: true,
    due: hasRows("crons", "w.enabled AND w.archived IS NOT TRUE"),
  });
  every("cron:asks", 5_000, () => sweepAsks(Date.now()), { due: hasRows("keychain_asks", "w.notified_at IS NULL") });
  every(
    "cron:stranded-fires",
    10 * 60_000,
    async () => {
      const swept = await crons.sweepStrandedFires(Date.now());
      if (swept > 0) console.warn(`[scheduler] closed ${swept} stranded running fire(s) as failed`);
    },
    { shared: true },
  );
  every(
    "cron:fire-gc",
    6 * 60 * 60_000,
    async () => {
      const pruned = await crons.pruneFires(Date.now());
      if (pruned > 0) console.log(`[scheduler] pruned ${pruned} old cron fire row(s)`);
    },
    { due: hasRows("cron_fires") },
  );
  return { scheduler, suggestedActivities };
}

export type SchedulerModule = ReturnType<typeof buildScheduler>;
