import "./instrument.ts";
import { createBackgroundController } from "./runs/background-controller.ts";
import { createManagedSlack } from "./surfaces/slack-managed.ts";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { loadConfig } from "./config.ts";
import { buildApp, serverDeps, stopWithBackstop } from "./wiring.ts";
import { shutdownOnUncaught } from "./util/process-guard.ts";
import { createServer } from "./api/server.ts";
import { dockerDaemonFailure } from "./deploy/docker-deploy-provider.ts";
import { errMessage, reportFailureAs } from "./util/errors.ts";
import { slackPluginConfigFromEnv } from "./slack/index.ts";
import { createSlackRuntime } from "./slack/runtime.ts";
import { createPgPool, migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { pgTenants, singleTenantResolver } from "./tenants/resolver.ts";
import { deriveConnectorKey } from "./connectors/connector-client-store.ts";
import { instanceTenant } from "./tenants/instance.ts";
import { enterTenant } from "./tenants/context.ts";

const config = loadConfig();

const built = buildApp(config);
await migrateRegisteredPgSchemas(config.databaseUrl);
const tenant = await instanceTenant(config);
if (tenant) enterTenant(tenant);
await built.sandboxResources.initialize();
const backfilledFires = await built.crons.backfillFires();
if (backfilledFires > 0) console.log(`[qm] backfilled ${backfilledFires} cron fire log entries into cron_fires`);
const envSlackConfig = slackPluginConfigFromEnv(process.env);
const slackConfig = envSlackConfig;
const envSlackAttempted = Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
let slackEnvironmentState: "absent" | "configured" | "partial" = "absent";
if (slackConfig) slackEnvironmentState = "configured";
else if (envSlackAttempted) slackEnvironmentState = "partial";
const resolver = config.databaseUrl ? singleTenantResolver(pgTenants(createPgPool(config.databaseUrl))) : undefined;
const slackRuntime =
  resolver && built.slackTables && built.slackInstallation
    ? createSlackRuntime({
        env: process.env,
        core: built.slackCore,
        tables: built.slackTables,
        installation: built.slackInstallation,
        resolver,
        managed: Boolean(process.env.QM_SLACK_SERVICE_URL),
      })
    : undefined;
if (!slackRuntime && slackEnvironmentState !== "absent")
  console.warn("[qm] Slack is configured but needs a Postgres database (DATABASE_URL); Slack will not start");
const managedSlack =
  process.env.QM_SLACK_SERVICE_URL && resolver && slackRuntime && built.slackInstallation
    ? createManagedSlack({
        serviceUrl: process.env.QM_SLACK_SERVICE_URL,
        token: process.env.QM_SLACK_SERVICE_TOKEN ?? "",
        stateSecret: config.connectorSecretKey
          ? deriveConnectorKey(config.connectorSecretKey, "slack-install-state").current.toString("base64url")
          : "",
        appId: process.env.QM_SLACK_APP_ID ?? "",
        store: built.slackInstallation,
        resolver,
        runtimes: slackRuntime,
      })
    : undefined;
const server = createServer(built.app, {
  ...serverDeps(config, built, slackEnvironmentState, envSlackConfig?.botToken),
  managedSlack,
});

await built.config.hydrate?.();
await built.refreshCustomProviders();
await built.identity.hydrate();
await built.deploymentLayerReady;
built.deploymentLayerRefresh.start();
built.runtime.start();

server.listen(config.port, () => {
  console.log(
    `[qm] listening on :${config.port} (org=${config.orgId}, store=${config.sessionStore}, ` +
      `runStore=${config.runStore}, workers=${config.workers}, backgroundWork=${config.backgroundWorkEnabled})`,
  );
});

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

if (config.databaseUrl && !config.adminGrants) {
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

if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) {
  built.scheduler.start(1000);
} else if (!config.backgroundDeploymentId) {
  console.log("[qm] background work disabled; scheduler and runtime loops will not start");
}

if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) slackRuntime?.start();

let backgroundController: ReturnType<typeof createBackgroundController> | undefined;
if (built.backgroundOwnership) {
  let periodicStop: Promise<void> = Promise.resolve();
  let activationEpoch = 0;
  const stopPeriodic = () => {
    activationEpoch++;
    periodicStop = built.scheduler.stopClaims();
    void periodicStop.catch((error) => console.error("[qm] periodic background stop failed:", errMessage(error)));
    void built.runtime
      .stopBackgroundClaims()
      .catch((error) => console.error("[qm] background claim stop failed:", errMessage(error)));
    void slackRuntime?.stop().catch((error) => console.error("[qm] Slack background stop failed:", errMessage(error)));
  };
  backgroundController = createBackgroundController({
    store: built.backgroundOwnership.store,
    deploymentId: built.backgroundOwnership.deploymentId,
    async start(signal) {
      const epoch = ++activationEpoch;
      if (signal.aborted) return;
      built.runtime.startBackground();
      await periodicStop;
      if (signal.aborted || epoch !== activationEpoch) return;
      built.scheduler.start(1000);
      await built.scheduler.ready();
      if (signal.aborted || epoch !== activationEpoch) return;
      if (signal.aborted) return;
      slackRuntime?.start();
      await slackRuntime?.reconcile();
    },
    fence: stopPeriodic,
    async relinquish() {
      await Promise.all([built.runtime.stopBackgroundClaims(), built.scheduler.stopClaims(), slackRuntime?.stop()]);
    },
    async drained() {
      await Promise.all([built.runtime.backgroundDrained(), built.scheduler.drained(), periodicStop]);
    },
    onError: reportFailureAs("background ownership", undefined),
  });
  built.runtime.setBackgroundAdmission(backgroundController.canClaim, backgroundController.active);
  backgroundController.start();
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  void slackRuntime?.stop().catch((e: unknown) => console.error("[qm] slack plugin stop failed:", errMessage(e)));
  void built.scheduler.stop().catch((e: unknown) => console.error("[qm] scheduler stop failed:", errMessage(e)));
  built.deploymentLayerRefresh.stop();
  server.close();
  server.closeIdleConnections();
  stopWithBackstop(
    {
      async stop() {
        await backgroundController?.stop();
        await built.runtime.stop();
      },
      releaseInFlightRuns: () => built.runtime.releaseInFlightRuns(),
    },
    config.shutdownDrainMs,
    "qm",
    () => server.closeAllConnections(),
  );
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm", shutdown);
