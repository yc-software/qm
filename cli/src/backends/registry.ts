import { awsWorkloadArchitecture, type QmConfig } from "../config.ts";
import { CliError, errMessage, note } from "../log.ts";
import type { Target } from "../providers.ts";
import { syncDeploymentLayer, type DeploymentLayerTransport } from "../deployment-layer.ts";
import { TARGET_ENV_DEFAULTS, type TargetEnvDefaults } from "../target-env-defaults.ts";
import { renderTerraformVars } from "../terraform.ts";
import { buildAwsMicrovmImage, deleteAwsMicrovmImage, deleteAwsTaskDefinitions } from "../commands/infra.ts";
import { awsScaffold, dockerScaffold, type ProviderScaffold } from "../provider-scaffold.ts";
import type { ResolvedPlugin } from "../plugins.ts";
import { runnableServices, serviceHost } from "../services.ts";
import {
  awsCheckLive,
  awsDoctor,
  awsDown,
  awsLogs,
  awsMigrateCandidate,
  awsRollback,
  awsSecretsPush,
  awsStatus,
  awsUp,
  awsDeploymentLayerTransport,
} from "./aws.ts";
import { dockerDeploymentLayerTransport, dockerDown, dockerLogs, dockerStatus, dockerUp } from "./docker.ts";
import { doctorCommon, localDoctorSecrets } from "./doctor.ts";
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

const workloadOptions = (flags: Readonly<Record<string, string | boolean>>, flag = "only"): string[] | undefined => {
  const raw = stringFlag(flags, flag);
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) throw new CliError(`--${flag} was given no components (e.g. --${flag} core,web-ui)`);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new CliError(`--${flag} lists ${duplicate} more than once`);
  return names;
};

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
  }),
  coordinates: () => ({}),
  validateConfig: () => [],
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
  upFlags: [
    "build-from",
    "only",
    "yes",
    "image-label",
    "build-only",
    "candidate",
    "candidate-out",
    "inactive",
    "restart",
    "build-concurrency",
  ],
  upOptions: (ctx, flags, dryRun) => {
    const only = workloadOptions(flags);
    const unknown = only?.filter((name) => !ctx.config.aws?.services[serviceHost(name)]) ?? [];
    if (unknown.length) throw new CliError(`--only has unknown AWS workload(s): ${unknown.join(", ")}`);
    const imageLabel = stringFlag(flags, "image-label");
    const candidate = stringFlag(flags, "candidate");
    const candidateOut = stringFlag(flags, "candidate-out");
    const buildConcurrency = stringFlag(flags, "build-concurrency");
    const restart = workloadOptions(flags, "restart");
    return {
      dryRun,
      yes: flags["yes"] === true,
      buildOnly: flags["build-only"] === true,
      inactive: flags["inactive"] === true,
      ...buildFromOptions(flags),
      ...(imageLabel ? { imageLabel } : {}),
      ...(candidate ? { candidate } : {}),
      ...(candidateOut ? { candidateOut } : {}),
      ...(buildConcurrency !== undefined ? { buildConcurrency: Number(buildConcurrency) } : {}),
      ...(restart ? { restart } : {}),
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
        ...(opts.buildOnly ? { buildOnly: true } : {}),
        ...(opts.candidate ? { candidate: opts.candidate } : {}),
        ...(opts.candidateOut ? { candidateOut: opts.candidateOut } : {}),
        ...(opts.buildConcurrency !== undefined ? { buildConcurrency: opts.buildConcurrency } : {}),
        ...(opts.restart ? { restart: opts.restart } : {}),
        ...(opts.inactive ? { inactive: true } : {}),
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
    migrateCandidate: (candidate) => awsMigrateCandidate(ctx.config, ctx.configDir, candidate),
  }),
  coordinates: (config) =>
    config.aws ? { accountOrOrganization: config.aws.accountId, region: config.aws.region } : {},
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
      if (!workloads.has(name) && !workloads.has(serviceHost(name))) {
        errors.push({
          clause: "config.v1",
          message: `contract aws.services.${name}: coordinates do not match an enabled service or discovered plugin`,
        });
      }
    }
    return errors;
  },
};

export const HOSTING_PROVIDERS = { docker, aws } satisfies Record<Target, HostingProvider>;

export const hostingProvider = (target: Target): HostingProvider => HOSTING_PROVIDERS[target];

export const hostingProviderUpFlags = (): string[] => [
  ...new Set(Object.values(HOSTING_PROVIDERS).flatMap((provider) => provider.upFlags)),
];
