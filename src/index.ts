import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { loadConfig } from "./config.ts";
import { buildApp, serverDeps, stopWithBackstop } from "./wiring.ts";
import { createServer } from "./api/server.ts";
import { dockerDaemonFailure } from "./deploy/docker-deploy-provider.ts";
import { errMessage } from "./util/errors.ts";
import { slackPluginConfigFromEnv, startSlackPlugin } from "./slack/index.ts";
import { createSlackRuntimeReconciler } from "./surfaces/slack-runtime.ts";

const config = loadConfig();

const built = buildApp(config);
const envSlackConfig = slackPluginConfigFromEnv(process.env);
const slackConfig = envSlackConfig;
const envSlackAttempted = Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
let slackEnvironmentState: "absent" | "configured" | "partial" = "absent";
if (slackConfig) slackEnvironmentState = "configured";
else if (envSlackAttempted) slackEnvironmentState = "partial";
const server = createServer(built.app, serverDeps(config, built, slackEnvironmentState, envSlackConfig?.botToken));

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

if (config.backgroundWorkEnabled) {
  built.scheduler.start(1000);
} else {
  console.log("[qm] background work disabled; scheduler and runtime loops will not start");
}

const slackRuntime = createSlackRuntimeReconciler({
  load: async () => {
    const status = await built.slackInstallation.status();
    const stored = await built.slackInstallation.get();
    if (stored) {
      const dynamic = slackPluginConfigFromEnv({
        ...process.env,
        SLACK_BOT_TOKEN: stored.botToken,
        SLACK_APP_TOKEN: stored.appToken,
      });
      return dynamic ? { version: stored.version, config: dynamic } : null;
    }
    if (status.managed) return null;
    if (slackConfig) return { version: "environment", config: slackConfig };
    return null;
  },
  startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
  onError: (error) => console.error(`[qm] slack plugin reconciliation failed: ${errMessage(error)}`),
});
slackRuntime.start();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  void slackRuntime.stop().catch((e: unknown) => console.error("[qm] slack plugin stop failed:", errMessage(e)));
  built.scheduler.stop();
  built.deploymentLayerRefresh.stop();
  server.close();
  server.closeIdleConnections();
  stopWithBackstop(built.runtime, config.shutdownDrainMs, "qm", () => server.closeAllConnections());
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
