import { awsWorkloadArchitecture, loadConfigAt, sandboxImagePinErrors, type QmConfig } from "../config.ts";
import { CliError, errMessage, note } from "../log.ts";
import type { Target } from "../providers.ts";
import { syncDeploymentLayer, type DeploymentLayerTransport } from "../deployment-layer.ts";
import { TARGET_ENV_DEFAULTS, type TargetEnvDefaults } from "../target-env-defaults.ts";
import { renderTerraformVars } from "../terraform.ts";
import { buildAwsMicrovmImage, deleteAwsMicrovmImage, deleteAwsTaskDefinitions } from "../commands/infra.ts";
import { runSandboxPublish, type SandboxPublishOpts } from "../commands/sandbox.ts";
import { awsScaffold, dockerScaffold, flyScaffold, type ProviderScaffold } from "../provider-scaffold.ts";
import type { ResolvedPlugin } from "../plugins.ts";
import { runnableServices } from "../services.ts";
import {
  assertAwsSandboxPinRecordable,
  awsCheckLive,
  awsDoctor,
  awsDown,
  awsLogs,
  awsPinSandbox,
  awsRollback,
  awsSecretsPush,
  awsStatus,
  awsUp,
  awsDeploymentLayerTransport,
} from "./aws.ts";
import { dockerDeploymentLayerTransport, dockerDown, dockerLogs, dockerStatus, dockerUp } from "./docker.ts";
import { doctorCommon, localDoctorSecrets } from "./doctor.ts";
import {
  flyCheckLive,
  flyDoctor,
  flyDown,
  flyLogs,
  flyPinSandbox,
  flyRollback,
  flySecretsPush,
  flyStatus,
  flyUp,
  flyDeploymentLayerTransport,
} from "./fly.ts";
import type { Backend, BackendUpOptions } from "./types.ts";

export interface DeployContext {
  config: QmConfig;
  configPath: string;
  configDir: string;
  sandboxDir: string;
  envFile?: string;
  target: Target;
}

type InfraOperation = "render" | "build-image" | "delete-image" | "delete-task-definitions";

export interface HostingProvider {
  id: Target;
  /** How this target's CLI reaches the deployed core's /v1/deployment-layer endpoint. */
  deploymentLayerTransport: DeploymentLayerTransport;
  /** Per-target env defaults applied when a service env var is not set explicitly. */
  envDefaults: TargetEnvDefaults;
  /** Optional `qm infra` operations; targets without managed infra omit this. */
  infra?: Partial<Record<InfraOperation, (ctx: DeployContext) => void | Promise<void>>>;
  upFlags: readonly string[];
  upOptions(ctx: DeployContext, flags: Readonly<Record<string, string | boolean>>, dryRun: boolean): BackendUpOptions;
  createBackend(ctx: DeployContext): Backend;
  coordinates(config: QmConfig): { accountOrOrganization?: string; region?: string };
  requiresSandboxApp: boolean;
  publishSandbox(ctx: DeployContext, opts: SandboxPublishOpts): Promise<void>;
  scaffold: ProviderScaffold;
  validateConfig(config: QmConfig, plugins: readonly ResolvedPlugin[]): Array<{ clause: string; message: string }>;
}

const stringFlag = (flags: Readonly<Record<string, string | boolean>>, name: string): string | undefined => {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CliError(`--${name} needs a value`, { clause: "cli.invocation" });
  return value;
};

const buildFromOptions = (
  flags: Readonly<Record<string, string | boolean>>,
): Pick<BackendUpOptions, "buildFrom" | "buildFromPath"> => {
  const value = flags["build-from"];
  return {
    buildFrom: value !== undefined,
    ...(typeof value === "string" ? { buildFromPath: value } : {}),
  };
};

const onlyOptions = (flags: Readonly<Record<string, string | boolean>>): string[] | undefined => {
  const raw = stringFlag(flags, "only");
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) throw new CliError(`--only was given no components (e.g. --only core,web-ui)`);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new CliError(`--only lists ${duplicate} more than once`);
  return names;
};

async function publishFlySandbox(ctx: DeployContext, opts: SandboxPublishOpts, pin: boolean): Promise<void> {
  const published = runSandboxPublish(opts);
  if (!published || opts.dryRun) return;
  const config = loadConfigAt(ctx.configPath, { target: ctx.target }).config;
  await syncDeploymentLayer({
    config,
    transport: hostingProvider(ctx.target).deploymentLayerTransport,
    configDir: ctx.configDir,
    sandboxDir: ctx.sandboxDir,
    ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
    allowUnavailable: true,
  });
  if (pin)
    await hostingProvider(ctx.target)
      .createBackend({ ...ctx, config })
      .pinSandbox(published.image);
}

const docker: HostingProvider = {
  id: "docker",
  deploymentLayerTransport: dockerDeploymentLayerTransport,
  envDefaults: TARGET_ENV_DEFAULTS.docker,
  scaffold: dockerScaffold,
  upFlags: ["build-from", "only"],
  upOptions: (_ctx, flags, dryRun) => {
    if (flags["only"] !== undefined) {
      throw new CliError(
        `--only is not supported for target docker; docker up always reconciles the full local stack`,
        { clause: "cli.invocation" },
      );
    }
    return { dryRun, ...buildFromOptions(flags) };
  },
  createBackend: (ctx) => ({
    up: async (opts) => {
      await dockerUp(ctx.config, ctx.configDir, {
        sandboxDir: ctx.sandboxDir,
        buildFrom: opts.buildFrom ?? false,
        ...(opts.buildFromPath ? { buildFromPath: opts.buildFromPath } : {}),
        ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
        dryRun: opts.dryRun,
      });
      if (!opts.dryRun) {
        await syncDeploymentLayer({
          config: ctx.config,
          transport: hostingProvider(ctx.target).deploymentLayerTransport,
          configDir: ctx.configDir,
          sandboxDir: ctx.sandboxDir,
          ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
        });
      }
    },
    status: () => dockerStatus(ctx.config),
    logs: (service, opts) => dockerLogs(ctx.config, service, opts),
    down: (opts) => dockerDown(ctx.config, opts),
    rollback: () => {
      throw new CliError("rollback is not implemented for target docker");
    },
    doctor: () =>
      doctorCommon(ctx.config, localDoctorSecrets(ctx.configDir, ctx.envFile), {
        requiredSecretValues: true,
        configDir: ctx.configDir,
      }),
    secretsPush: () => {
      note("docker reads .env directly; no secret upload is needed");
    },
    pinSandbox: () => {
      note("sandbox pin recorded; re-run `qm up` to restart a local core with it");
    },
  }),
  coordinates: () => ({}),
  requiresSandboxApp: true,
  publishSandbox: (ctx, opts) => publishFlySandbox(ctx, opts, false),
  validateConfig: (config) => sandboxImagePinErrors(config),
};

const fly: HostingProvider = {
  id: "fly",
  deploymentLayerTransport: flyDeploymentLayerTransport,
  envDefaults: TARGET_ENV_DEFAULTS.fly,
  scaffold: flyScaffold,
  upFlags: ["build-from", "only", "image-label", "image-from", "image-repo-prefix", "build-only"],
  upOptions: (_ctx, flags, dryRun) => {
    const only = onlyOptions(flags);
    const imageFrom = stringFlag(flags, "image-from");
    const imageLabel = stringFlag(flags, "image-label");
    const imageRepoPrefix = stringFlag(flags, "image-repo-prefix");
    return {
      dryRun,
      buildOnly: flags["build-only"] === true,
      ...buildFromOptions(flags),
      ...(only ? { only } : {}),
      ...(imageFrom ? { imageFrom } : {}),
      ...(imageLabel ? { imageLabel } : {}),
      ...(imageRepoPrefix ? { imageRepoPrefix } : {}),
    };
  },
  createBackend: (ctx) => ({
    up: async (opts) => {
      await flyUp(ctx.config, ctx.configDir, {
        dryRun: opts.dryRun,
        configPath: ctx.configPath,
        ...(opts.buildFrom !== undefined ? { buildFrom: opts.buildFrom } : {}),
        ...(opts.buildFromPath ? { buildFromPath: opts.buildFromPath } : {}),
        ...(opts.only ? { only: opts.only } : {}),
        ...(opts.imageFrom ? { imageFrom: opts.imageFrom } : {}),
        ...(opts.imageLabel ? { imageLabel: opts.imageLabel } : {}),
        ...(opts.imageRepoPrefix ? { imageRepoPrefix: opts.imageRepoPrefix } : {}),
        ...(opts.buildOnly ? { buildOnly: true } : {}),
      });
      if (!opts.dryRun && !opts.buildOnly && (!opts.only || opts.only.includes("core"))) {
        await syncDeploymentLayer({
          config: ctx.config,
          transport: hostingProvider(ctx.target).deploymentLayerTransport,
          configDir: ctx.configDir,
          sandboxDir: ctx.sandboxDir,
          ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
          allowUnavailable: true,
        });
      }
    },
    status: () => flyStatus(ctx.config, ctx.configDir),
    logs: (service, opts) => flyLogs(ctx.config, ctx.configDir, service, opts),
    down: () => flyDown(ctx.config, ctx.configDir),
    rollback: (to) => flyRollback(ctx.config, ctx.configPath, to),
    doctor: () => flyDoctor(ctx.config, ctx.configDir, ctx.envFile),
    secretsPush: (envFile) => flySecretsPush(ctx.config, ctx.configDir, envFile),
    checkLive: (opts) => flyCheckLive(ctx.config, ctx.configDir, opts),
    pinSandbox: (image) => flyPinSandbox(ctx.config, image, ctx.configDir),
  }),
  coordinates: (config) => ({
    ...(config.flyOrg ? { accountOrOrganization: config.flyOrg } : {}),
    ...(config.region ? { region: config.region } : {}),
  }),
  requiresSandboxApp: true,
  publishSandbox: (ctx, opts) => publishFlySandbox(ctx, opts, true),
  validateConfig: (config) => {
    const errors: Array<{ clause: string; message: string }> = [...sandboxImagePinErrors(config)];
    if (!config.region?.trim())
      errors.push({ clause: "config.v1", message: 'contract config.fly.region: target "fly" requires "region"' });
    if (!config.flyOrg?.trim())
      errors.push({ clause: "config.v1", message: 'contract config.fly.flyOrg: target "fly" requires "flyOrg"' });
    const core = config.env.core ?? {};
    if (core.SNAPSHOT_STORE !== "s3" || core.TRANSFER_STORE !== "s3") {
      errors.push({
        clause: "config.v1",
        message:
          'contract config.fly.durability: a Fly deployment requires env.core.SNAPSHOT_STORE and TRANSFER_STORE to be "s3"',
      });
    }
    if (!core.S3_BUCKET?.trim() || !core.S3_REGION?.trim()) {
      errors.push({
        clause: "config.v1",
        message: "contract config.fly.durability: a Fly deployment requires env.core.S3_BUCKET and S3_REGION",
      });
    }
    return errors;
  },
};

const aws: HostingProvider = {
  id: "aws",
  deploymentLayerTransport: awsDeploymentLayerTransport,
  envDefaults: TARGET_ENV_DEFAULTS.aws,
  infra: {
    render: (ctx) => renderTerraformVars(ctx.config, ctx.configDir),
    "build-image": async (ctx) => {
      await buildAwsMicrovmImage(ctx.config, ctx.configPath);
    },
    "delete-image": (ctx) => deleteAwsMicrovmImage(ctx.config),
    "delete-task-definitions": (ctx) => deleteAwsTaskDefinitions(ctx.config),
  },
  scaffold: awsScaffold,
  upFlags: ["build-from", "only", "yes", "image-label"],
  upOptions: (ctx, flags, dryRun) => {
    const only = onlyOptions(flags);
    const unknown = only?.filter((name) => !ctx.config.aws?.services[name]) ?? [];
    if (unknown.length) throw new CliError(`--only has unknown AWS workload(s): ${unknown.join(", ")}`);
    const imageLabel = stringFlag(flags, "image-label");
    return {
      dryRun,
      yes: flags["yes"] === true,
      ...buildFromOptions(flags),
      ...(imageLabel ? { imageLabel } : {}),
      ...(only ? { only } : {}),
    };
  },
  createBackend: (ctx) => ({
    up: (opts) =>
      awsUp(ctx.config, ctx.configDir, {
        dryRun: opts.dryRun,
        ...(opts.yes !== undefined ? { yes: opts.yes } : {}),
        ...(opts.buildFrom !== undefined ? { buildFrom: opts.buildFrom } : {}),
        ...(opts.buildFromPath ? { buildFromPath: opts.buildFromPath } : {}),
        ...(opts.imageLabel ? { imageLabel: opts.imageLabel } : {}),
        ...(opts.only ? { only: opts.only } : {}),
        sandboxDir: ctx.sandboxDir,
        ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
      }),
    status: () => awsStatus(ctx.config, ctx.configDir),
    logs: (service, opts) => awsLogs(ctx.config, service, opts, ctx.configDir),
    down: () => awsDown(ctx.config, ctx.configDir),
    rollback: (to) =>
      awsRollback(ctx.config, to, { configDir: ctx.configDir, ...(ctx.envFile ? { envFile: ctx.envFile } : {}) }),
    doctor: () => awsDoctor(ctx.config, ctx.configDir),
    secretsPush: (envFile) => awsSecretsPush(ctx.config, ctx.configDir, envFile),
    checkLive: (opts) =>
      awsCheckLive(ctx.config, {
        ...opts,
        configDir: ctx.configDir,
        sandboxDir: ctx.sandboxDir,
        ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
      }),
    pinSandbox: (image) =>
      awsPinSandbox(ctx.config, image, {
        configDir: ctx.configDir,
        sandboxDir: ctx.sandboxDir,
        ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
      }),
  }),
  coordinates: (config) =>
    config.aws ? { accountOrOrganization: config.aws.accountId, region: config.aws.region } : {},
  requiresSandboxApp: false,
  publishSandbox: async (ctx, opts) => {
    if (ctx.config.sandbox?.backend !== "sprites") {
      throw new CliError(
        `this AWS deployment runs Lambda MicroVM sandboxes (sandbox.backend is not "sprites"); use \`qm sandbox build\` to validate the layer and \`qm infra build-image\` to publish the runtime — or set "sandbox.backend": "sprites" with "sandbox.app" to host sandboxes in an operator-published layer image`,
      );
    }
    if (!opts.dryRun) assertAwsSandboxPinRecordable(ctx.config);
    const published = runSandboxPublish(opts);
    if (!published || opts.dryRun) return;
    const config = loadConfigAt(ctx.configPath, { target: ctx.target }).config;
    await hostingProvider(ctx.target)
      .createBackend({ ...ctx, config })
      .pinSandbox(published.image);
  },
  validateConfig: (config, plugins) => {
    if (!config.aws) return [];
    const errors: Array<{ clause: string; message: string }> = [];
    const workloads = new Set<string>([...runnableServices(config.services), ...plugins.map((plugin) => plugin.name)]);
    for (const name of workloads) {
      if (!config.aws.services[name]) {
        errors.push({
          clause: "config.v1",
          message: `contract aws.services.${name}: every AWS service and plugin needs ECS/ECR coordinates`,
        });
        continue;
      }
      try {
        awsWorkloadArchitecture(config, name);
      } catch (error) {
        errors.push({ clause: "config.v1", message: `contract ${errMessage(error)}` });
      }
    }
    for (const name of Object.keys(config.aws.services)) {
      if (!workloads.has(name)) {
        errors.push({
          clause: "config.v1",
          message: `contract aws.services.${name}: coordinates do not match an enabled service or discovered plugin`,
        });
      }
    }
    return errors;
  },
};

export const HOSTING_PROVIDERS = { docker, fly, aws } satisfies Record<Target, HostingProvider>;

export const hostingProvider = (target: Target): HostingProvider => HOSTING_PROVIDERS[target];

export const hostingProviderUpFlags = (): string[] => [
  ...new Set(Object.values(HOSTING_PROVIDERS).flatMap((provider) => provider.upFlags)),
];
