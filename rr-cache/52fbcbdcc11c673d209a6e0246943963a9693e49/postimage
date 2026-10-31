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
import { createServer } from "./http/server.ts";
import { dockerDaemonFailure } from "../deploy/docker-deploy-provider.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";
import { slackPluginConfigFromEnv } from "../slack/index.ts";
import { createPgPool, migrateRegisteredPgSchemas } from "../persistence/pg-pool.ts";
import { pgTenants, singleTenantResolver } from "../tenants/resolver.ts";
import { retiredEnvPresent, tenantEnvPresent } from "../tenants/settings-import.ts";
import { createSlackRuntime } from "../slack/runtime.ts";
import { deriveConnectorKey } from "../connectors/connector-client-store.ts";
import { migrateTenantStorageOnce } from "../tenants/storage-migration.ts";
import { assertRuntimeLogin } from "../persistence/runtime-login.ts";

const config = loadConfig();

const core = buildCore(config);
const edge = buildEdge(config, core);
await migrateRegisteredPgSchemas(config.databaseUrl);
await assertRuntimeLogin(config.databaseUrl!);
await migrateTenantStorageOnce(config);
await core.tenantSettings.refreshAll();
const tenantEnv = tenantEnvPresent(process.env);
if (tenantEnv.length)
  console.warn(
    `[qm] ${tenantEnv.join(", ")} ${tenantEnv.length === 1 ? "is a tenant setting" : "are tenant settings"} and not read from the environment; copy them into the tenant with PUT /v1/tenant-settings, then remove them.`,
  );
const retiredEnv = retiredEnvPresent(process.env);
if (retiredEnv.length)
  console.warn(
    `[qm] ${retiredEnv.join(", ")} ${retiredEnv.length === 1 ? "is" : "are"} no longer read; add broker credentials and connector tokens in admin settings, and save ChatGPT or Claude logins as keychain credentials named by CODEX_AUTH_CREDENTIAL or CLAUDE_AUTH_CREDENTIAL.`,
  );
await core.boot();
const envSlackConfig = slackPluginConfigFromEnv(process.env);
const envSlackAttempted = Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
let slackEnvironmentState: "absent" | "configured" | "partial" = "absent";
if (envSlackConfig) slackEnvironmentState = "configured";
else if (envSlackAttempted) slackEnvironmentState = "partial";
const resolver = singleTenantResolver(pgTenants(core.slackTables.pool));
const slackRuntime = createSlackRuntime({
  env: process.env,
  core: edge.slackCore,
  tables: core.slackTables,
  installation: core.slackInstallation,
  resolver,
  managed: Boolean(process.env.QM_SLACK_SERVICE_URL),
});
const managedSlack = process.env.QM_SLACK_SERVICE_URL
  ? createManagedSlack({
      serviceUrl: process.env.QM_SLACK_SERVICE_URL,
      token: process.env.QM_SLACK_SERVICE_TOKEN ?? "",
      stateSecret: config.connectorSecretKey
        ? deriveConnectorKey(config.connectorSecretKey, "slack-install-state").current.toString("base64url")
        : "",
      appId: process.env.QM_SLACK_APP_ID ?? "",
      store: core.slackInstallation,
      resolver,
      runtimes: slackRuntime,
    })
  : undefined;
const server = createServer(core.app, {
  ...serverDeps(config, core, edge, slackEnvironmentState, envSlackConfig?.botToken),
  managedSlack,
  tenants: singleTenantResolver(pgTenants(createPgPool(config.databaseUrl!))),
});

core.deploymentLayerRefresh.start();
await core.cronQueue.start(null);
edge.runtime.start();

await new Promise<void>((resolve) => server.listen(config.port, resolve));
console.log(`[qm] edge listening on :${config.port}`);
const frontDoor = config.publicPort
  ? await startFrontDoor({ apiPort: config.port, publicPort: config.publicPort }, process.env)
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

if (config.deployProvider === "docker") {
  void dockerDaemonFailure().then((failure) => {
    if (failure)
      console.warn(
        `[qm] publishing is unavailable: the docker deploy provider is selected but no Docker daemon is reachable from core (${failure}) — make a daemon reachable, or set DEPLOY_PROVIDER to fly or aws`,
      );
  });
}

if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) slackRuntime.start();

const backgroundController = core.backgroundOwnership
  ? createBackgroundController({
      store: core.backgroundOwnership.store,
      deploymentId: core.backgroundOwnership.deploymentId,
      async start(signal) {
        if (signal.aborted) return;
        slackRuntime.start();
        await slackRuntime.reconcile();
      },
      fence() {
        void slackRuntime
          .stop()
          .catch((error) => console.error("[qm] Slack background stop failed:", errMessage(error)));
      },
      async relinquish() {
        await slackRuntime.stop();
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
  void slackRuntime.stop().catch((e: unknown) => console.error("[qm] Slack stop failed:", errMessage(e)));
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
