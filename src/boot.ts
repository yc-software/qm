import { createBackgroundController } from "./runs/background-controller.ts";
import { createManagedSlack, type ManagedSlack } from "./surfaces/slack-managed.ts";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Server } from "node:http";
import { loadConfig, type Config } from "./config.ts";
import { buildApp, serverDeps } from "./wiring.ts";
import { createServer } from "./api/server.ts";
import { dockerDaemonFailure } from "./deploy/docker-deploy-provider.ts";
import { errMessage, reportFailureAs } from "./util/errors.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv, startSlackPlugin } from "./slack/index.ts";
import { createSlackRuntimeReconciler } from "./surfaces/slack-runtime.ts";
import { createPgPool, migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { mergeTenantQueues } from "./turns/absurd-schema.ts";
import { hostOfUrl, setEdgeTenants } from "../plugins/chassis/src/tenant-hosts.ts";
import { tagErrorDeployment } from "../plugins/chassis/src/error-reporting.ts";
import { homeHosts, homeTenantSettings } from "../plugins/chassis/src/tenant-settings.ts";
import { tenant, tenantSettings, withTenant, type Tenant } from "./tenant.ts";
import {
  activeTenants,
  createTenantDirectory,
  homeTenantHosts,
  isHomeTenant,
  useTenantDirectory,
  watchActiveTenants,
} from "./tenants/directory.ts";
import { tenantConfig } from "./tenants/tenant-config.ts";
import { assertRowSecurityEnforced, tenantSecretsKey } from "./tenants/registry.ts";

export interface BootedApp {
  config: Config;
  server: Server;
  beginShutdown(): void;
  stop(): Promise<void>;
  releaseInFlightRuns(): Promise<void>;
}

export async function bootApp(
  env: NodeJS.ProcessEnv,
  serve: (server: Server, config: Config) => Promise<void>,
): Promise<BootedApp> {
  const config = loadConfig(env);
  const slackIngress = config.backgroundWorkEnabled && !config.backgroundDeploymentId;

  const built = buildApp(config, { env });
  await migrateRegisteredPgSchemas(config.databaseUrl);
  if (config.databaseUrl) await mergeTenantQueues(config.databaseUrl);
  const publishEdge = config.multitenant ? edgeTenantFeed(env) : undefined;
  if (publishEdge) {
    await useRegistryTenants(config, env, async () => {
      await built.start();
      await built.refreshCustomProviders();
    });
    watchActiveTenants(publishEdge);
  }
  const slackConfig = slackPluginConfigFromEnv(env);
  let slackEnvironmentState: "absent" | "configured" | "partial" = slackConfig ? "configured" : "absent";
  if (!slackConfig && (env.SLACK_BOT_TOKEN || env.SLACK_APP_TOKEN)) slackEnvironmentState = "partial";
  const slack = createTenantSlack({ env, config, built, slackConfig, running: slackIngress });
  const server = createServer(
    built.app,
    serverDeps(config, built, slackEnvironmentState, slackConfig?.botToken, () => slack.managed()),
  );

  await built.start();
  await built.refreshCustomProviders();
  built.runtime.start();

  publishEdge?.(await activeTenants());
  await serve(server, config);

  warnAboutUnreachableFeatures(config);

  if (!config.backgroundWorkEnabled && !config.backgroundDeploymentId)
    console.log("[qm] background work disabled; scheduler and runtime loops will not start");

  slack.ensure();
  watchActiveTenants(slack.sync);
  slack.sync(await activeTenants());

  const slackAccountRuntimes = slackAccountConfigsFromEnv(env).map((account) =>
    createSlackRuntimeReconciler({
      startPaused: Boolean(config.backgroundDeploymentId),
      load: () => Promise.resolve({ version: `environment:${account.accountId}`, config: account }),
      startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
      onError: reportFailureAs("slack account reconciliation", undefined, `account=${account.accountId}`),
    }),
  );
  if (slackIngress) for (const runtime of slackAccountRuntimes) runtime.start();

  const backgroundController = built.backgroundOwnership
    ? startBackgroundOwnership(built, built.backgroundOwnership, [slack.runtimes, ...slackAccountRuntimes])
    : undefined;

  return {
    config,
    server,
    beginShutdown() {
      void slack.runtimes.stop().catch((e: unknown) => console.error("[qm] slack plugin stop failed:", errMessage(e)));
      for (const runtime of slackAccountRuntimes)
        void runtime.stop().catch((e: unknown) => console.error("[qm] slack account stop failed:", errMessage(e)));
    },
    async stop() {
      await backgroundController?.stop();
      await built.runtime.stop();
    },
    releaseInFlightRuns: () => built.runtime.releaseInFlightRuns(),
  };
}

function warnAboutUnreachableFeatures(config: Config): void {
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
          `[qm] publishing is unavailable: the docker deploy provider is selected but no Docker daemon is reachable from core (${failure}) — make a daemon reachable, or set DEPLOY_PROVIDER to aws`,
        );
    });
  }
}

type SlackRuntime = ReturnType<typeof createSlackRuntimeReconciler>;

export function edgeTenantFeed(env: NodeJS.ProcessEnv): (active: Tenant[]) => void {
  const home = homeTenantSettings(env, tenant());
  return (active) =>
    setEdgeTenants(
      active.map((t) => {
        if (!isHomeTenant(t)) return tenantSettings(t);
        const { hosts, appsDomain } = homeTenantHosts();
        return { ...home, hosts: [...hosts], appsDomain };
      }),
    );
}

async function useRegistryTenants(config: Config, env: NodeJS.ProcessEnv, prepare: () => Promise<void>): Promise<void> {
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) throw new Error("QM_MULTITENANT=1 needs DATABASE_URL to read the tenant registry");
  const pool = createPgPool(databaseUrl);
  await assertRowSecurityEnforced(pool);
  tagErrorDeployment(() =>
    isHomeTenant(tenant()) ? undefined : (tenantConfig(config).sentryDeployment ?? tenant().orgId),
  );
  const secretsKey = tenantSecretsKey(env);
  useTenantDirectory(
    createTenantDirectory({
      databaseUrl,
      pool,
      secretsKey,
      home: tenant(),
      homeHosts: [config.publicUrl, config.apiBaseUrl, config.publicWebUrl]
        .map(hostOfUrl)
        .filter((host): host is string => Boolean(host))
        .concat(homeHosts(env)),
      ...(config.deployAppsDomain ? { homeAppsDomain: config.deployAppsDomain } : {}),
      homeSandboxPrefix: config.sandbox.namePrefix ?? "qm",
      prepare,
    }),
  );
}

const SHARED_SLACK_ENV = [
  "QM_SLACK_SERVICE_URL",
  "SLACK_API_URL",
  "SLACK_HISTORY_LIMIT",
  "SLACK_LOG_LEVEL",
  "DEV_HEALTH_PORT",
  "DEV_INSTANCE_NO_SLACK",
  "DEV_INTROSPECTION",
];

interface TenantSlackEntry {
  tenant: Tenant;
  managed?: ManagedSlack;
  runtime: SlackRuntime;
}

function createTenantSlack(opts: {
  env: NodeJS.ProcessEnv;
  config: Config;
  built: ReturnType<typeof buildApp>;
  slackConfig: ReturnType<typeof slackPluginConfigFromEnv>;
  running: boolean;
}) {
  const { env, config, built, slackConfig } = opts;
  const entries = new Map<string, TenantSlackEntry>();
  let running = opts.running;

  function slackEnvOf(t: Tenant): NodeJS.ProcessEnv {
    if (isHomeTenant(t)) return env;
    const shared = Object.fromEntries(SHARED_SLACK_ENV.map((name) => [name, env[name]]));
    return { ...shared, WEB_UI_PUBLIC_URL: tenantConfig(config).publicWebUrl };
  }

  async function load(entry: TenantSlackEntry) {
    const status = await built.slackInstallation.status();
    const stored = await built.slackInstallation.get();
    const managed = entry.managed;
    if (stored) {
      if (stored.installId && !managed) return null;
      const dynamic = slackPluginConfigFromEnv(
        { ...slackEnvOf(entry.tenant), SLACK_BOT_TOKEN: stored.botToken, SLACK_APP_TOKEN: stored.appToken },
        stored.installId && managed ? (staging) => managed.receiver(stored.installId!, staging) : undefined,
      );
      if (dynamic && stored.installId) dynamic.installationId = stored.installId;
      return dynamic ? { version: stored.version, config: dynamic } : null;
    }
    if (status.managed || !isHomeTenant(entry.tenant)) return null;
    if (slackConfig) return { version: "environment", config: slackConfig };
    return null;
  }

  function ensure(): TenantSlackEntry {
    const t = tenant();
    const key = t.id ?? "";
    const existing = entries.get(key);
    if (existing) return existing;
    const entry = { tenant: t } as TenantSlackEntry;
    const token = tenantConfig(config).slackServiceToken ?? (isHomeTenant(t) ? "" : undefined);
    if (env.QM_SLACK_SERVICE_URL && token !== undefined)
      entry.managed = createManagedSlack({
        serviceUrl: env.QM_SLACK_SERVICE_URL,
        token,
        appId: env.QM_SLACK_APP_ID ?? "",
        store: built.slackInstallation,
        reconcile:
          opts.running || config.backgroundDeploymentId
            ? () => withTenant(t, () => entry.runtime.reconcile())
            : undefined,
      });
    entry.runtime = createSlackRuntimeReconciler({
      startPaused: Boolean(config.backgroundDeploymentId),
      load: () => withTenant(t, () => load(entry)),
      startPlugin: (desired) => withTenant(t, () => startSlackPlugin(desired, built.slackCore)),
      onError: reportFailureAs("slack plugin reconciliation", undefined, `tenant=${t.slug ?? "home"}`),
    });
    entries.set(key, entry);
    if (running) withTenant(t, () => entry.runtime.start());
    return entry;
  }

  const all = (fn: (entry: TenantSlackEntry) => Promise<void>) =>
    Promise.all([...entries.values()].map((entry) => withTenant(entry.tenant, () => fn(entry)))).then(() => {});

  const runtimes: SlackRuntime = {
    start() {
      running = true;
      for (const entry of entries.values()) withTenant(entry.tenant, () => entry.runtime.start());
    },
    reconcile: () => all((entry) => entry.runtime.reconcile()),
    stop() {
      running = false;
      return all((entry) => entry.runtime.stop());
    },
  };

  const sync = (active: Tenant[]) => {
    const keep = new Set(active.map((t) => t.id ?? ""));
    for (const t of active) withTenant(t, ensure);
    for (const [key, entry] of entries) {
      if (keep.has(key)) continue;
      entries.delete(key);
      void withTenant(entry.tenant, () => entry.runtime.stop()).catch(
        reportFailureAs("slack plugin stop", undefined, `tenant=${entry.tenant.slug ?? key}`),
      );
    }
  };

  return { ensure, sync, managed: () => ensure().managed, runtimes };
}

function startBackgroundOwnership(
  built: ReturnType<typeof buildApp>,
  ownership: NonNullable<ReturnType<typeof buildApp>["backgroundOwnership"]>,
  slackRuntimes: SlackRuntime[],
) {
  const controller = createBackgroundController({
    store: ownership.store,
    deploymentId: ownership.deploymentId,
    async start(signal) {
      if (signal.aborted) return;
      built.runtime.startBackground();
      for (const runtime of slackRuntimes) {
        if (signal.aborted) return;
        runtime.start();
        await runtime.reconcile();
      }
    },
    fence() {
      void built.runtime.stopBackgroundClaims().catch(reportFailureAs("qm: background claim stop", undefined));
      for (const runtime of slackRuntimes)
        void runtime.stop().catch(reportFailureAs("qm: Slack background stop", undefined));
    },
    async relinquish() {
      await Promise.all([built.runtime.stopBackgroundClaims(), ...slackRuntimes.map((runtime) => runtime.stop())]);
    },
    drained: () => built.runtime.backgroundDrained(),
    onError: reportFailureAs("background ownership", undefined),
  });
  built.runtime.setBackgroundAdmission(controller.canClaim, controller.active);
  controller.start();
  return controller;
}
