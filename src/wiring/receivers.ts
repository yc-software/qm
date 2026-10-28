import type { SandboxModule } from "./sandbox.ts";
import { hasRows } from "../jobs/job-worker.ts";
import type { RunsModule } from "./runs.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { CronsModule } from "./crons.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { StoresModule } from "./stores.ts";
import type { Head } from "./late.ts";
import { type SandboxHandle, supportsProcessSessions } from "../sandbox/sandbox.ts";
import { finishProcessCredentials } from "../credentials/execute-files.ts";
import { type MonitorPoller, createMonitorPoller, MONITOR_POLL_MS } from "../monitors/monitor-poller.ts";
import { createWebhookReceiver } from "../webhooks/webhook-receiver.ts";

type ReceiversInputs = Pick<Head, "admittedWork"> & {
  sandbox: SandboxModule;
  runs: RunsModule;
  credentials: CredentialsModule;
  crons: CronsModule;
  apiApp: ApiAppModule;
  stores: StoresModule;
};

export function buildReceivers(deps: ReceiversInputs) {
  const { sandbox } = deps.sandbox;
  const { processes } = deps.runs;
  const { keychain } = deps.credentials;
  const { admittedWork } = deps;
  const { monitors, webhooks } = deps.crons;
  const { triggerDeps } = deps.apiApp;
  const { jobs, every } = deps.stores;

  const finishCredentials = (handle: SandboxHandle, processId: string) =>
    finishProcessCredentials({ sandbox, processes: processes!, keychain }, handle, processId);
  const monitorPoller: MonitorPoller | null =
    processes && supportsProcessSessions(sandbox)
      ? createMonitorPoller({
          admittedWork,
          monitors,
          processes,
          sandbox,
          ...triggerDeps,
          onProcessExit: finishCredentials,
        })
      : null;
  const webhookReceiver = createWebhookReceiver({
    webhooks,
    ...triggerDeps,
    jobs,
  });
  if (monitorPoller)
    every("monitor:poll", MONITOR_POLL_MS, () => monitorPoller.tick(), { due: hasRows("monitors", "w.enabled") });
  return { finishCredentials, webhookReceiver };
}

export type ReceiversModule = ReturnType<typeof buildReceivers>;
