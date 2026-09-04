import { loadConfig } from "./config.ts";
import { buildApp, serverDeps, stopWithBackstop } from "./wiring.ts";
import { createServer } from "./api/server.ts";
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
