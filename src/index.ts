import "./instrument.ts";
import { createManagedSlack } from "./surfaces/slack-managed.ts";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { loadConfig } from "./config.ts";
import { buildApp, serverDeps, stopWithBackstop } from "./wiring.ts";
import { shutdownOnUncaught } from "./util/process-guard.ts";
import { createServer } from "./api/server.ts";
import { dockerDaemonFailure } from "./deploy/docker-deploy-provider.ts";
import { errMessage, reportFailure, reportFailureAs } from "./util/errors.ts";
import { sleep } from "./util/async.ts";
import {
  slackAccountConfigsFromEnv,
  slackPluginConfigFromEnv,
  startSlackPlugin,
  type SlackPluginConfig,
} from "./slack/index.ts";
import { createSlackRuntimeReconciler, holdSlackRuntimesByLease } from "./surfaces/slack-runtime.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";

const JOB_START_RETRY_MS = 5000;
const config = loadConfig();

const built = buildApp(config);
await migrateRegisteredPgSchemas(config.databaseUrl);
await built.sandboxResources.initialize();
const backfilledFires = await built.crons.backfillFires();
if (backfilledFires > 0) console.log(`[qm] backfilled ${backfilledFires} cron fire log entries into cron_fires`);
const envSlackConfig = slackPluginConfigFromEnv(process.env);
const slackConfig = envSlackConfig;
const envSlackAttempted = Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
let slackEnvironmentState: "absent" | "configured" | "partial" = "absent";
if (slackConfig) slackEnvironmentState = "configured";
else if (envSlackAttempted) slackEnvironmentState = "partial";
const managedSlack = process.env.QM_SLACK_SERVICE_URL
  ? createManagedSlack({
      serviceUrl: process.env.QM_SLACK_SERVICE_URL,
      token: process.env.QM_SLACK_SERVICE_TOKEN ?? "",
      appId: process.env.QM_SLACK_APP_ID ?? "",
      store: built.slackInstallation,
      reconcile: async () => {
        await Promise.all([slackRuntime.requests.reconcile(), slackRuntime.socket.reconcile()]);
      },
    })
  : undefined;
const server = createServer(built.app, {
  ...serverDeps(config, built, slackEnvironmentState, envSlackConfig?.botToken),
  managedSlack,
});

await built.config.hydrate?.();
await built.refreshCustomProviders();
await built.identity.refresh();
await built.deploymentLayerReady;
built.deploymentLayerRefresh.start();
built.runtime.start();

server.listen(config.port, () => {
  console.log(`[qm] listening on :${config.port} (org=${config.orgId}, ` + `workers=${config.workers})`);
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

let shuttingDown = false;
async function startJobs(): Promise<void> {
  while (!shuttingDown) {
    try {
      await built.jobs.start();
      return;
    } catch (e) {
      reportFailure("job worker start", e);
      await sleep(JOB_START_RETRY_MS, { unref: true });
    }
  }
}

void startJobs();

const loadSlackInstallation = async () => {
  const status = await built.slackInstallation.status();
  const stored = await built.slackInstallation.get();
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
  if (slackConfig) return { version: "environment", config: slackConfig };
  return null;
};
const socketMode = (config: SlackPluginConfig) =>
  !config.receiverFactory && (config.eventsMode ?? "socket") === "socket";
function slackRuntimes(
  load: () => Promise<{ version: string; config: SlackPluginConfig } | null>,
  onError: (error: unknown) => void,
) {
  const reconciler = (socket: boolean) =>
    createSlackRuntimeReconciler({
      startPaused: true,
      load: async () => {
        const desired = await load();
        return desired && socketMode(desired.config) === socket ? desired : null;
      },
      startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
      onError,
    });
  return { socket: reconciler(true), requests: reconciler(false) };
}
const slackRuntime = slackRuntimes(loadSlackInstallation, reportFailureAs("slack plugin reconciliation", undefined));
const slackAccountRuntimes = slackAccountConfigsFromEnv(process.env).map((account) =>
  slackRuntimes(
    () => Promise.resolve({ version: `environment:${account.accountId}`, config: account }),
    reportFailureAs("slack account reconciliation", undefined, `account=${account.accountId}`),
  ),
);
const slackRequestRuntimes = [slackRuntime.requests, ...slackAccountRuntimes.map((runtime) => runtime.requests)];
for (const runtime of slackRequestRuntimes) runtime.start();
const slackOwner = holdSlackRuntimesByLease({
  lease: built.leaderLease,
  runtimes: [slackRuntime.socket, ...slackAccountRuntimes.map((runtime) => runtime.socket)],
  onError: reportFailureAs("slack socket ownership", undefined),
});
slackOwner.start();

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  void Promise.all([slackOwner.stop(), ...slackRequestRuntimes.map((runtime) => runtime.stop())]).catch((e: unknown) =>
    console.error("[qm] slack stop failed:", errMessage(e)),
  );
  void built.jobs.stop().catch((e: unknown) => console.error("[qm] job worker stop failed:", errMessage(e)));
  built.deploymentLayerRefresh.stop();
  server.close();
  server.closeIdleConnections();
  stopWithBackstop(built.runtime, config.shutdownDrainMs, "qm", () => server.closeAllConnections());
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm", shutdown);
