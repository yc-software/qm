import "../instrument.ts";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { loadConfig } from "../config.ts";
import { buildCore, stopWithBackstop } from "../wiring.ts";
import { buildEdge, serverDeps } from "./build.ts";
import { startFrontDoor } from "./front-door.ts";
import { createBackgroundController } from "../runs/background-controller.ts";
import { createManagedSlack } from "../surfaces/slack-managed.ts";
import { shutdownOnUncaught } from "../util/process-guard.ts";
import { createServer } from "../api/server.ts";
import { dockerDaemonFailure } from "../deploy/docker-deploy-provider.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv, startSlackPlugin } from "../slack/index.ts";
import { createSlackRuntimeReconciler } from "../surfaces/slack-runtime.ts";
import { migrateRegisteredPgSchemas } from "../persistence/pg-pool.ts";

const config = loadConfig();

const core = buildCore(config);
const edge = buildEdge(config, core);
await migrateRegisteredPgSchemas(config.databaseUrl);
await core.sandboxResources.initialize();
const envSlackConfig = slackPluginConfigFromEnv(process.env);
const envSlackAttempted = Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
let slackEnvironmentState: "absent" | "configured" | "partial" = "absent";
if (envSlackConfig) slackEnvironmentState = "configured";
else if (envSlackAttempted) slackEnvironmentState = "partial";
const managedSlack = process.env.QM_SLACK_SERVICE_URL
  ? createManagedSlack({
      serviceUrl: process.env.QM_SLACK_SERVICE_URL,
      token: process.env.QM_SLACK_SERVICE_TOKEN ?? "",
      appId: process.env.QM_SLACK_APP_ID ?? "",
      store: core.slackInstallation,
      reconcile:
        config.backgroundWorkEnabled || config.backgroundDeploymentId ? () => slackRuntime.reconcile() : undefined,
    })
  : undefined;
const server = createServer(core.app, {
  ...serverDeps(config, core, edge, slackEnvironmentState, envSlackConfig?.botToken),
  managedSlack,
});

await core.config.hydrate?.();
await core.refreshCustomProviders();
await core.identity.hydrate();
await core.deploymentLayerReady;
core.deploymentLayerRefresh.start();
await core.cronQueue.start(null);
edge.runtime.start();

await new Promise<void>((resolve) => server.listen(config.port, resolve));
console.log(`[qm] edge listening on :${config.port} (org=${config.orgId})`);
const frontDoor = config.publicPort
  ? await startFrontDoor({ apiPort: config.port, publicPort: config.publicPort, orgId: config.orgId }, process.env)
  : undefined;
if (config.publicPort) console.log(`[qm] front door listening on :${config.publicPort}`);

if (config.deployAppsDomain) {
  const domain = config.deployAppsDomain;
  const probe = `qm-probe-${randomBytes(4).toString("hex")}.${domain}`;
  void lookup(probe).catch(() => {
    console.warn(
      `[qm] app subdomains are configured but *.${domain} does not resolve (probed ${probe}) — ` +
        `add a wildcard DNS record for *.${domain} pointing at this instance's ingress, or apps will only be reachable at /d/<app>/`,
    );
  });
}

if (!config.adminGrants) {
  console.warn(
    "[qm] ADMIN_GRANTS is unset with a durable store — if this deployment has never named an admin, the admin console is unreachable and cannot be unlocked from inside the product; set ADMIN_GRANTS=<email>:org_admin (ignore this if an admin was already promoted in the Users tab).",
  );
}

if (config.deployProvider === "docker") {
  void dockerDaemonFailure().then((failure) => {
    if (failure)
      console.warn(
        `[qm] publishing is unavailable: the docker deploy provider is selected but no Docker daemon is reachable from core (${failure}) — make a daemon reachable, or set DEPLOY_PROVIDER to fly or aws`,
      );
  });
}

const slackRuntime = createSlackRuntimeReconciler({
  startPaused: Boolean(config.backgroundDeploymentId),
  load: async () => {
    const status = await core.slackInstallation.status();
    const stored = await core.slackInstallation.get();
    if (stored) {
      if (stored.installId && !managedSlack) return null;
      const dynamic = slackPluginConfigFromEnv(
        {
          ...process.env,
          SLACK_BOT_TOKEN: stored.botToken,
          SLACK_APP_TOKEN: stored.appToken,
          SLACK_EVENTS_MODE: stored.appToken ? "socket" : process.env.SLACK_EVENTS_MODE,
        },
        stored.installId && managedSlack ? (staging) => managedSlack.receiver(stored.installId!, staging) : undefined,
      );
      if (dynamic && stored.installId) dynamic.installationId = stored.installId;
      return dynamic ? { version: stored.version, config: dynamic } : null;
    }
    if (status.managed) return null;
    if (envSlackConfig) return { version: "environment", config: envSlackConfig };
    return null;
  },
  startPlugin: (desired) => startSlackPlugin(desired, edge.slackCore),
  onError: reportFailureAs("slack plugin reconciliation", undefined),
});
const slackAccountRuntimes = slackAccountConfigsFromEnv(process.env).map((account) =>
  createSlackRuntimeReconciler({
    startPaused: Boolean(config.backgroundDeploymentId),
    load: () => Promise.resolve({ version: `environment:${account.accountId}`, config: account }),
    startPlugin: (desired) => startSlackPlugin(desired, edge.slackCore),
    onError: reportFailureAs("slack account reconciliation", undefined, `account=${account.accountId}`),
  }),
);
const slackRuntimes = [slackRuntime, ...slackAccountRuntimes];
if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) for (const runtime of slackRuntimes) runtime.start();

const backgroundController = core.backgroundOwnership
  ? createBackgroundController({
      store: core.backgroundOwnership.store,
      deploymentId: core.backgroundOwnership.deploymentId,
      async start(signal) {
        for (const runtime of slackRuntimes) {
          if (signal.aborted) return;
          runtime.start();
          await runtime.reconcile();
        }
      },
      fence() {
        for (const runtime of slackRuntimes)
          void runtime.stop().catch((error) => console.error("[qm] Slack background stop failed:", errMessage(error)));
      },
      async relinquish() {
        await Promise.all(slackRuntimes.map((runtime) => runtime.stop()));
      },
      async drained() {},
      onError: reportFailureAs("background ownership", undefined),
    })
  : undefined;
if (backgroundController) {
  core.setBackgroundAdmission(backgroundController.canClaim, backgroundController.active);
  backgroundController.start();
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  for (const runtime of slackRuntimes)
    void runtime.stop().catch((e: unknown) => console.error("[qm] Slack stop failed:", errMessage(e)));
  core.deploymentLayerRefresh.stop();
  void frontDoor?.close().catch((e: unknown) => console.error("[qm] front door stop failed:", errMessage(e)));
  server.close();
  server.closeIdleConnections();
  stopWithBackstop(
    {
      async stop() {
        await backgroundController?.stop();
        await edge.runtime.stop();
      },
      releaseInFlightRuns: async () => core.releaseWaiters(),
    },
    config.shutdownDrainMs,
    "qm",
    () => server.closeAllConnections(),
  );
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm", shutdown);
