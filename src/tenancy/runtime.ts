import { createBackgroundController } from "../runs/background-controller.ts";
import { backgroundTaskArn } from "../runs/background-task-identity.ts";
import { createManagedSlack } from "../surfaces/slack-managed.ts";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Config } from "../config.ts";
import { buildApp, serverDeps } from "../wiring.ts";
import { createRequestListener } from "../api/server.ts";
import { dockerDaemonFailure } from "../deploy/docker-deploy-provider.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv, startSlackPlugin } from "../slack/index.ts";
import { createSlackRuntimeReconciler } from "../surfaces/slack-runtime.ts";
import { migrateRegisteredPgSchemas } from "../persistence/pg-pool.ts";

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createTenantSlackHttp } from "./slack-http.ts";
import type { WorkCapacity } from "../runs/work-capacity.ts";
import { runWithTenant, type TenantContext } from "../tenancy/context.ts";

export interface TenantRuntime {
  listener?: RequestListener;
  start(): Promise<void>;
  stop(): Promise<void>;
  releaseInFlightRuns(): Promise<void>;
}

export function prepareTenant(
  context: TenantContext,
  config: Config,
  capacity: WorkCapacity,
  workerOnly = false,
): Promise<TenantRuntime> {
  return runWithTenant(context, async () => {
    const env = context.env;
    const accountConfigs = slackAccountConfigsFromEnv(env);
    const slackHttp = context.pooled ? createTenantSlackHttp() : undefined;
    const built = buildApp(config, { capacity });
    const stoppers: Array<() => Promise<void> | void> = [
      () => built.runtime.stop(),
      () => built.scheduler.stop(),
      () => built.suggestedActivityMaintenance.stop(),
      () => built.deploymentLayerRefresh.stop(),
    ];
    let stopped = false;
    let starting: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopped = true;
      stopping ??= runWithTenant(context, async () => {
        const results = await Promise.allSettled([
          built.runtime.stopBackgroundClaims(),
          ...stoppers.map((stopper) => Promise.resolve().then(stopper)),
        ]);
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, `Tenant ${context.id} could not drain cleanly`);
      });
      return stopping;
    };
    try {
      await migrateRegisteredPgSchemas(config.databaseUrl);
      await built.sandboxResources.initialize();
      const backfilledFires = await built.crons.backfillFires();
      if (backfilledFires > 0) console.log(`[qm] backfilled ${backfilledFires} cron fire log entries into cron_fires`);
      const envSlackConfig = slackPluginConfigFromEnv(env);
      const slackConfig = envSlackConfig;
      const envSlackAttempted = Boolean(env.SLACK_BOT_TOKEN || env.SLACK_APP_TOKEN);
      let slackEnvironmentState: "absent" | "configured" | "partial" = "absent";
      if (slackConfig) slackEnvironmentState = "configured";
      else if (envSlackAttempted) slackEnvironmentState = "partial";
      const managedSlack = env.QM_SLACK_SERVICE_URL
        ? createManagedSlack({
            serviceUrl: env.QM_SLACK_SERVICE_URL,
            token: env.QM_SLACK_SERVICE_TOKEN ?? "",
            appId: env.QM_SLACK_APP_ID ?? "",
            store: built.slackInstallation,
            reconcile:
              config.backgroundWorkEnabled || config.backgroundDeploymentId
                ? () => slackRuntime.reconcile()
                : undefined,
          })
        : undefined;
      const coreListener = workerOnly
        ? undefined
        : createRequestListener(built.app, {
            ...serverDeps(config, built, slackEnvironmentState, envSlackConfig?.botToken),
            managedSlack,
            tenantId: context.id,
            requireTenantBinding: context.pooled,
          });
      const listener: RequestListener | undefined =
        coreListener &&
        ((req, res) => {
          if (!slackHttp) return coreListener(req, res);
          void slackHttp
            .handle(req, res)
            .then((handled) => {
              if (!handled) coreListener(req, res);
            })
            .catch((error) => {
              console.error("[qm] Slack ingress failed:", errMessage(error));
              if (!res.headersSent) res.writeHead(500);
              res.end();
            });
        });

      await built.config.hydrate?.();
      await built.refreshCustomProviders();
      await built.identity.hydrate();
      await built.deploymentLayerReady;

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
              stored.installId && managedSlack
                ? (staging) => managedSlack.receiver(stored.installId!, staging)
                : undefined,
            );
            if (dynamic && stored.installId) dynamic.installationId = stored.installId;
            return dynamic ? { version: stored.version, config: dynamic } : null;
          }
          if (status.managed) return null;
          if (slackConfig) return { version: "environment", config: slackConfig };
          return null;
        },
        startPlugin: (desired) => startSlackPlugin(slackHttp?.wrap(desired) ?? desired, built.slackCore),
        onError: reportFailureAs("slack plugin reconciliation", undefined),
      });
      stoppers.push(() => slackRuntime.stop());

      const slackAccountRuntimes = accountConfigs.map((account) =>
        createSlackRuntimeReconciler({
          startPaused: true,
          load: () => Promise.resolve({ version: `environment:${account.accountId}`, config: account }),
          startPlugin: (desired) => startSlackPlugin(slackHttp?.wrap(desired) ?? desired, built.slackCore),
          onError: reportFailureAs("slack account reconciliation", undefined, `account=${account.accountId}`),
        }),
      );
      for (const runtime of slackAccountRuntimes) stoppers.push(() => runtime.stop());

      let backgroundController: ReturnType<typeof createBackgroundController> | undefined;
      if (built.backgroundOwnership) {
        const identity = {
          ...built.backgroundOwnership,
          taskArn: await backgroundTaskArn(env.ECS_CONTAINER_METADATA_URI_V4),
        };
        let periodicStop: Promise<void> = Promise.resolve();
        let activationEpoch = 0;
        const stopPeriodic = () => {
          activationEpoch++;
          periodicStop = Promise.all([built.scheduler.stopClaims(), built.suggestedActivityMaintenance.stop()]).then(
            () => {},
          );
          void periodicStop.catch((error) => console.error("[qm] periodic background stop failed:", errMessage(error)));
          void built.runtime
            .stopBackgroundClaims()
            .catch((error) => console.error("[qm] background claim stop failed:", errMessage(error)));
          for (const runtime of [slackRuntime, ...slackAccountRuntimes])
            void runtime
              .stop()
              .catch((error) => console.error("[qm] Slack background stop failed:", errMessage(error)));
        };
        backgroundController = createBackgroundController({
          store: identity.store,
          identity: { deploymentId: identity.deploymentId, instanceId: identity.instanceId, taskArn: identity.taskArn },
          legacyEnabled: config.backgroundWorkEnabled,
          async start(signal) {
            const epoch = ++activationEpoch;
            if (signal.aborted) return;
            built.runtime.startBackground();
            if (workerOnly) return;
            await periodicStop;
            if (signal.aborted || epoch !== activationEpoch) return;
            built.scheduler.start(1000);
            await built.scheduler.ready();
            if (signal.aborted || epoch !== activationEpoch) return;
            built.suggestedActivityMaintenance.start();
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
        built.runtime.setBackgroundAdmission(backgroundController.canClaim);
        const controller = backgroundController;
        stoppers.push(() => controller.stop());
      }

      return {
        listener:
          listener && ((req: IncomingMessage, res: ServerResponse) => runWithTenant(context, () => listener(req, res))),
        start(): Promise<void> {
          if (stopped) return Promise.reject(new Error(`Tenant ${context.id} is stopped`));
          starting ??= runWithTenant(context, async () => {
            try {
              built.deploymentLayerRefresh.start();
              built.runtime.start();
              if (!workerOnly && config.backgroundWorkEnabled && !config.backgroundDeploymentId) {
                built.scheduler.start(1000);
                built.suggestedActivityMaintenance.start();
                for (const runtime of [slackRuntime, ...slackAccountRuntimes]) runtime.start();
              }
              backgroundController?.start();
            } catch (error) {
              await stop().catch((failure) =>
                console.error(`[qm] tenant ${context.id} activation cleanup failed:`, errMessage(failure)),
              );
              throw error;
            }
          });
          return starting;
        },
        stop,
        releaseInFlightRuns: () => runWithTenant(context, () => built.runtime.releaseInFlightRuns()),
      };
    } catch (error) {
      await stop().catch((failure) =>
        console.error(`[qm] tenant ${context.id} startup cleanup failed:`, errMessage(failure)),
      );
      throw error;
    }
  });
}
