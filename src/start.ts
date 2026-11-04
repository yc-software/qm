import { createBackgroundController } from "./runs/background-controller.ts";
import { createManagedSlack } from "./surfaces/slack-managed.ts";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import type { Config } from "./config.ts";
import { buildApp, serverDeps } from "./wiring.ts";
import { createServer } from "./api/server.ts";
import { dockerDaemonFailure } from "./deploy/docker-deploy-provider.ts";
import { errMessage, reportFailureAs } from "./util/errors.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv, startSlackPlugin } from "./slack/index.ts";
import { createSlackRuntimeReconciler } from "./surfaces/slack-runtime.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";

export async function startQm(
  config: Config,
  { env = {}, ...overrides }: Parameters<typeof buildApp>[1] & { env?: NodeJS.ProcessEnv } = {},
) {
  const built = buildApp(config, overrides);
  await migrateRegisteredPgSchemas(config.databaseUrl);
  if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) await built.ownSharedState();
  const slackConfig = slackPluginConfigFromEnv(env);
  let slackEnvironmentState: "absent" | "configured" | "partial" =
    env.SLACK_BOT_TOKEN || env.SLACK_APP_TOKEN ? "partial" : "absent";
  if (slackConfig) slackEnvironmentState = "configured";
  const managedSlack = env.QM_SLACK_SERVICE_URL
    ? createManagedSlack({
        serviceUrl: env.QM_SLACK_SERVICE_URL,
        token: env.QM_SLACK_SERVICE_TOKEN ?? "",
        appId: env.QM_SLACK_APP_ID ?? "",
        store: built.slackInstallation,
        reconcile:
          config.backgroundWorkEnabled || config.backgroundDeploymentId ? () => slackRuntime.reconcile() : undefined,
      })
    : undefined;
  const server = createServer(built.app, {
    ...serverDeps(config, built, slackEnvironmentState, slackConfig?.botToken),
    managedSlack,
  });

  await built.config.hydrate?.();
  await built.refreshCustomProviders();
  await built.identity.refresh();
  await built.deploymentLayerReady;
  built.deploymentLayerRefresh.start();
  server.listen(config.port);
  await once(server, "listening");
  built.runtime.start();

  console.log(
    `[qm] listening on :${config.port} (org=${config.orgId}, ` +
      `workers=${config.workers}, backgroundWork=${config.backgroundWorkEnabled})`,
  );

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

  if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) {
    built.scheduler.start(1000);
  } else if (!config.backgroundDeploymentId) {
    console.log("[qm] background work disabled; scheduler and runtime loops will not start");
  }

  const slackRuntime = createSlackRuntimeReconciler({
    startPaused: Boolean(config.backgroundDeploymentId),
    load: async () => {
      const status = await built.slackInstallation.status();
      const stored = await built.slackInstallation.get();
      if (stored) {
        if (stored.installId && !managedSlack) return null;
        const dynamic = slackPluginConfigFromEnv(
          {
            ...env,
            SLACK_BOT_TOKEN: stored.botToken,
            SLACK_APP_TOKEN: stored.appToken,
            SLACK_EVENTS_MODE: stored.appToken ? "socket" : env.SLACK_EVENTS_MODE,
          },
          stored.installId && managedSlack ? (staging) => managedSlack.receiver(stored.installId!, staging) : undefined,
        );
        if (dynamic && stored.installId) dynamic.installationId = stored.installId;
        return dynamic ? { version: stored.version, config: dynamic } : null;
      }
      if (status.managed) return null;
      if (slackConfig) return { version: "environment", config: slackConfig };
      return null;
    },
    startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
    onError: reportFailureAs("slack plugin reconciliation", undefined),
  });
  if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) slackRuntime.start();

  const slackAccountRuntimes = slackAccountConfigsFromEnv(env).map((account) =>
    createSlackRuntimeReconciler({
      startPaused: Boolean(config.backgroundDeploymentId),
      load: () => Promise.resolve({ version: `environment:${account.accountId}`, config: account }),
      startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
      onError: reportFailureAs("slack account reconciliation", undefined, `account=${account.accountId}`),
    }),
  );
  if (config.backgroundWorkEnabled && !config.backgroundDeploymentId)
    for (const runtime of slackAccountRuntimes) runtime.start();

  let backgroundController: ReturnType<typeof createBackgroundController> | undefined;
  if (built.backgroundOwnership) {
    let periodicStop: Promise<void> = Promise.resolve();
    let activationEpoch = 0;
    let sharedStateOwned = false;
    const stopPeriodic = () => {
      activationEpoch++;
      periodicStop = built.scheduler.stopClaims();
      void periodicStop.catch((error) => console.error("[qm] periodic background stop failed:", errMessage(error)));
      void built.runtime
        .stopBackgroundClaims()
        .catch((error) => console.error("[qm] background claim stop failed:", errMessage(error)));
      for (const runtime of [slackRuntime, ...slackAccountRuntimes])
        void runtime.stop().catch((error) => console.error("[qm] Slack background stop failed:", errMessage(error)));
    };
    backgroundController = createBackgroundController({
      store: built.backgroundOwnership.store,
      deploymentId: built.backgroundOwnership.deploymentId,
      async start(signal) {
        const epoch = ++activationEpoch;
        if (signal.aborted) return;
        if (!sharedStateOwned) {
          await built.ownSharedState();
          sharedStateOwned = true;
          if (signal.aborted || epoch !== activationEpoch) return;
        }
        built.runtime.startBackground();
        await periodicStop;
        if (signal.aborted || epoch !== activationEpoch) return;
        built.scheduler.start(1000);
        await built.scheduler.ready();
        if (signal.aborted || epoch !== activationEpoch) return;
        for (const runtime of [slackRuntime, ...slackAccountRuntimes]) {
          if (signal.aborted) return;
          runtime.start();
          await runtime.reconcile();
        }
      },
      fence: stopPeriodic,
      async relinquish() {
        await Promise.all([
          built.runtime.stopBackgroundClaims(),
          built.scheduler.stopClaims(),
          ...[slackRuntime, ...slackAccountRuntimes].map((runtime) => runtime.stop()),
        ]);
      },
      async drained() {
        await Promise.all([built.runtime.backgroundDrained(), built.scheduler.drained(), periodicStop]);
      },
      onError: reportFailureAs("background ownership", undefined),
    });
    built.runtime.setBackgroundAdmission(backgroundController.canClaim, backgroundController.active);
    backgroundController.start();
  }

  return {
    built,
    server,
    releaseInFlightRuns: () => built.runtime.releaseInFlightRuns(),
    async stop() {
      void slackRuntime.stop().catch((e: unknown) => console.error("[qm] slack plugin stop failed:", errMessage(e)));
      for (const runtime of slackAccountRuntimes)
        void runtime.stop().catch((e: unknown) => console.error("[qm] slack account stop failed:", errMessage(e)));
      void built.scheduler.stop().catch((e: unknown) => console.error("[qm] scheduler stop failed:", errMessage(e)));
      built.deploymentLayerRefresh.stop();
      server.close();
      server.closeIdleConnections();
      await backgroundController?.stop();
      await built.runtime.stop();
    },
  };
}
