import { listedPrincipals } from "../plugins/chassis/src/principal-allowlist.ts";
import { createManagedSlack } from "./surfaces/slack-managed.ts";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import type { Config } from "./config.ts";
import { buildApp, serverDeps } from "./wiring.ts";
import { createServer } from "./api/server.ts";
import { dockerDaemonFailure } from "./deploy/docker-deploy-provider.ts";
import { errMessage, reportFailureAs } from "./util/errors.ts";
import { sleep } from "./util/async.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv, startSlackPlugin } from "./slack/index.ts";
import { createSlackRuntimeReconciler } from "./surfaces/slack-runtime.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { sessionLifetime } from "../plugins/portal/src/session.ts";
import { startFrontDoor } from "./web/front-door.ts";
import { sweepDictationSpool } from "./api/routes/voice.ts";
import { parseAllowedOrigins } from "../plugins/portal/src/cors.ts";
import { createWebEvents } from "./api/routes/web-events.ts";
import { webMeConfig } from "./api/routes/web-me.ts";

export async function startQm(
  config: Config,
  { env = {}, ...overrides }: Parameters<typeof buildApp>[1] & { env?: NodeJS.ProcessEnv } = {},
) {
  const built = buildApp(config, overrides);
  await migrateRegisteredPgSchemas(config.databaseUrl);
  if (config.backgroundWorkEnabled) await built.ownSharedState();
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
        reconcile: config.backgroundWorkEnabled ? () => slackRuntime.reconcile() : undefined,
      })
    : undefined;
  const draining = new AbortController();
  const web =
    config.publicPort === undefined ? undefined : { events: createWebEvents(built.app, built), me: webMeConfig(env) };
  const server = createServer(built.app, {
    ...serverDeps(config, built, slackEnvironmentState, slackConfig?.botToken),
    managedSlack,
    ...(config.openaiApiKey ? { openaiApiKey: config.openaiApiKey } : {}),
    ...(env.PORTAL_SESSION_SECRET
      ? {
          portalSession: {
            secret: env.PORTAL_SESSION_SECRET,
            maxAgeSeconds: sessionLifetime(env).max,
            principals: listedPrincipals(env.WEB_UI_PRINCIPALS),
            inboxUsers: env.INBOX_USERS,
            apiOrigins: parseAllowedOrigins(env.PORTAL_API_ALLOWED_ORIGINS).origins,
          },
        }
      : {}),
    ...(web ? { web } : {}),
    draining: draining.signal,
  });

  await built.config.hydrate?.();
  await built.refreshCustomProviders();
  await built.identity.refresh();
  await built.deploymentLayerReady;
  built.deploymentLayerRefresh.start();
  server.listen(config.port);
  await once(server, "listening");
  void sweepDictationSpool();
  const frontDoor =
    config.publicPort === undefined
      ? undefined
      : await startFrontDoor({ ...config, publicPort: config.publicPort }, env, server);
  web?.events.start();

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

  if (!config.backgroundWorkEnabled)
    console.log("[qm] background work disabled; scheduler and runtime loops will not start");

  const slackRuntime = createSlackRuntimeReconciler({
    startPaused: true,
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

  const slackAccountRuntimes = slackAccountConfigsFromEnv(env).map((account) =>
    createSlackRuntimeReconciler({
      startPaused: true,
      load: () => Promise.resolve({ version: `environment:${account.accountId}`, config: account }),
      startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
      onError: reportFailureAs("slack account reconciliation", undefined, `account=${account.accountId}`),
    }),
  );

  const slackRuntimes = [slackRuntime, ...slackAccountRuntimes];
  built.runtime.start({
    resume() {
      built.scheduler.start(1000);
      for (const runtime of slackRuntimes) runtime.start();
    },
    async standDown() {
      const stopped = await Promise.allSettled([
        built.scheduler.stopClaims(),
        ...slackRuntimes.map((runtime) => runtime.stop()),
      ]);
      const failures = stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failures.length) throw new AggregateError(failures, "background stand-down failed");
    },
  });

  return {
    built,
    server,
    releaseInFlightRuns: () => built.runtime.releaseInFlightRuns(),
    async stop() {
      draining.abort();
      const deadline = sleep(config.shutdownDrainMs);
      void slackRuntime.stop().catch((e: unknown) => console.error("[qm] slack plugin stop failed:", errMessage(e)));
      for (const runtime of slackAccountRuntimes)
        void runtime.stop().catch((e: unknown) => console.error("[qm] slack account stop failed:", errMessage(e)));
      void built.scheduler.stop().catch((e: unknown) => console.error("[qm] scheduler stop failed:", errMessage(e)));
      built.deploymentLayerRefresh.stop();
      await built.runtime.stop(async () => {
        await deadline;
        frontDoor?.close();
        await web?.events.stop();
        server.close();
        server.closeAllConnections();
      });
    },
  };
}
