import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lookup, resolveCname } from "node:dns/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireAwsLease as acquireLease,
  awsText,
  deployLocksTable,
  releaseAwsLease as releaseLease,
  withAwsLease,
} from "../aws-lease.ts";
import { CliError, dim, errMessage, header, note, ok, step, warn } from "../log.ts";
import {
  awsWorkloadArchitecture,
  isDigestPinned,
  sandboxCoreEnv,
  securityScreenEnv,
  type AwsConfig,
  type QmConfig,
} from "../config.ts";
import { manifestRef } from "../manifest.ts";
import {
  computedSecrets,
  validatedSecrets,
  runtimeSecretNames,
  secretsForService,
  type ComputedSecret,
} from "../secrets.ts";
import {
  brokerWiring,
  brandEnvOf,
  orgEnv,
  runnableServices,
  hostedServiceEnv,
  serviceHost,
  serviceDef,
  isServiceName,
  virtualServiceEnv,
  type LogOpts,
  type ServiceName,
} from "../services.ts";
import { discoverPlugins, type ResolvedPlugin } from "../plugins.ts";
import {
  canonicalJson,
  capture,
  deploymentSecretValue,
  envNum,
  isInvalidSecret,
  isMissingOrPlaceholder,
  promptHidden,
  readEnvFile,
  resolveBuildRepoRoot,
  runInherit,
  runInheritAsync,
  settleAll,
  sleep,
  streamLabeled,
} from "../util.ts";
import { doctorCommon } from "./doctor.ts";
import {
  assertTerraformScaffoldSupportsConfig,
  awsObjectStoreBucket,
  declaredVariables,
  terraformVarsDrift,
} from "../terraform.ts";
import {
  currentDeploymentLayerState,
  deploymentLayerBody,
  syncDeploymentLayerBody,
  type DeploymentLayerSyncResult,
  httpDeploymentLayerTransport,
  type DeploymentLayerTransport,
} from "../deployment-layer.ts";

export const awsDeploymentLayerTransport: DeploymentLayerTransport = httpDeploymentLayerTransport({
  urlOf: (config) => {
    const url = new URL(config.apiUrl ?? config.publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new CliError("AWS deployment-layer URL must be HTTPS without credentials or a fragment");
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/deployment-layer`;
    return url;
  },
  request: async (config, url, init) => {
    const target = awsPublicFrontDoor(config).dnsName.toLowerCase().replace(/\.$/, "");
    if (!validAlbHostname(target)) throw new CliError("AWS deployment-layer ALB hostname is invalid");
    if (awsPublicOrigin(config).protocol === "http:") {
      assertCloudFrontLayerTarget(config, url, target);
      const response = await fetch(url, init);
      return { status: response.status, body: await response.text() };
    }
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          hostname: target,
          servername: url.hostname,
          method: init.method,
          headers: { ...(init.headers as Record<string, string>), host: url.host },
          signal: init.signal ?? undefined,
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      request.on("error", reject);
      request.end(init.body as string | undefined);
    });
  },
  secretFallback: (config) =>
    config.aws
      ? capture(process.env.AWS_BIN ?? "aws", [
          "secretsmanager",
          "get-secret-value",
          "--secret-id",
          `${config.aws.secretsPrefix}CORE_SIGNING_SECRET`,
          "--query",
          "SecretString",
          "--output",
          "text",
          "--region",
          config.aws.region,
        ]).trim()
      : undefined,
  timeoutMs: 60_000,
});
export interface AwsUpOpts {
  dryRun?: boolean;
  yes?: boolean;
  buildFrom?: boolean;
  buildFromPath?: string;
  imageLabel?: string;
  only?: string[];
  restart?: string[];
  sandboxDir?: string;
  envFile?: string;
  buildOnly?: boolean;
  buildConcurrency?: number;
  candidate?: string;
  candidateOut?: string;
  inactive?: boolean;
}

interface AwsMigrationService {
  status?: string;
  launchType?: string;
  platformVersion?: string;
  networkConfiguration?: {
    awsvpcConfiguration?: {
      subnets?: string[];
      securityGroups?: string[];
      assignPublicIp?: string;
    };
  };
}

export interface EcsTaskDefinition {
  family: string;
  networkMode: "awsvpc";
  requiresCompatibilities: ["FARGATE"];
  cpu: string;
  memory: string;
  runtimePlatform: { cpuArchitecture: "ARM64" | "X86_64"; operatingSystemFamily: "LINUX" };
  executionRoleArn: string;
  taskRoleArn: string;
  containerDefinitions: Array<Record<string, unknown>>;
}

function requireAws(config: QmConfig): AwsConfig {
  if (!config.aws) throw new CliError('target "aws" requires an aws block');
  return config.aws;
}

function rdsInstanceIdentifier(aws: AwsConfig): string {
  return aws.rdsInstance ?? `${aws.cluster}-core`;
}

function deployedAwsServices(aws: AwsConfig): string[] {
  return Object.keys(aws.services).filter((name) => serviceHost(name) === name);
}

function awsTopology(
  config: QmConfig,
  configDir: string,
): { aws: AwsConfig; workloads: string[]; plugins: ResolvedPlugin[] } {
  const aws = requireAws(config);
  assertTerraformScaffoldSupportsConfig(config, configDir);
  const discovered = discoverPlugins(configDir, config);
  if (discovered.errors.length) throw new CliError(discovered.errors.join("\n"));
  const workloads = [...runnableServices(config.services), ...discovered.plugins.map((plugin) => plugin.name)];
  const enabled = new Set(workloads);
  const stale = Object.keys(aws.services)
    .filter((workload) => !enabled.has(workload) && !enabled.has(serviceHost(workload)))
    .sort();
  const missing = workloads.filter((workload) => !aws.services[workload]);
  if (stale.length || missing.length) {
    const problems = [
      ...(stale.length ? [`disabled workloads: ${stale.join(", ")}`] : []),
      ...(missing.length ? [`missing enabled workloads: ${missing.join(", ")}`] : []),
    ];
    throw new CliError(`aws.services topology mismatch (${problems.join("; ")})`);
  }
  return { aws, workloads, plugins: discovered.plugins };
}

function containerSecretNames(service: string, secret: ComputedSecret): string[] {
  const names = runtimeSecretNames(service, secret);
  return names.length ? names : [secret.name];
}

function awsArgs(aws: AwsConfig, args: string[]): string[] {
  return [...args, "--region", aws.region];
}

function awsJson<T>(aws: AwsConfig, args: string[]): T {
  const raw = capture(process.env.AWS_BIN ?? "aws", awsArgs(aws, [...args, "--output", "json"]));
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

function assertAwsCallerAccount(aws: AwsConfig): void {
  const account = awsText(aws, ["sts", "get-caller-identity", "--query", "Account"]);
  if (account !== aws.accountId) {
    throw new CliError(`authenticated to AWS account ${account || "unknown"}, expected ${aws.accountId}`);
  }
}

function registerTaskDefinition(config: QmConfig, file: string): string {
  return awsText(config.aws!, [
    "ecs",
    "register-task-definition",
    "--cli-input-json",
    `file://${file}`,
    "--tags",
    JSON.stringify([
      { key: "ManagedBy", value: "qm-cli" },
      { key: "Deployment", value: config.orgId },
    ]),
    "--query",
    "taskDefinition.taskDefinitionArn",
  ]);
}

function deployImageCoordinates(config: QmConfig): { name: string; version: string } {
  const name = config.env.core?.AWS_DEPLOY_IMAGE?.trim();
  const version = config.env.core?.AWS_DEPLOY_IMAGE_VERSION?.trim();
  if (!name || !version || isMissingOrPlaceholder(name) || isMissingOrPlaceholder(version)) {
    throw new CliError("AWS requires exact env.core.AWS_DEPLOY_IMAGE and AWS_DEPLOY_IMAGE_VERSION coordinates");
  }
  return { name, version };
}

export function guardLambdaMicrovms(e: unknown): never {
  if (/invalid choice:?\s*'?lambda-microvms/i.test(errMessage(e))) {
    throw new CliError(
      "this AWS CLI lacks the `lambda-microvms` commands needed to build/verify the AWS deploy MicroVM image; install an AWS CLI with Lambda MicroVMs support",
    );
  }
  throw e instanceof Error ? e : new Error(errMessage(e));
}

function assertAwsDeployImage(config: QmConfig): void {
  const aws = requireAws(config);
  const { name, version } = deployImageCoordinates(config);
  const expectedArn = `arn:aws:lambda:${aws.region}:${aws.accountId}:microvm-image:${name}`;
  let image: Record<string, unknown>;
  try {
    image = awsJson<Record<string, unknown>>(aws, [
      "lambda-microvms",
      "get-microvm-image",
      "--image-identifier",
      expectedArn,
    ]);
  } catch (e) {
    if (/invalid choice:?\s*'?lambda-microvms/i.test(errMessage(e))) return;
    guardLambdaMicrovms(e);
  }
  const detail = (image.image && typeof image.image === "object" ? image.image : image) as Record<string, unknown>;
  const arn = detail.imageArn ?? detail.imageARN ?? detail.arn;
  if (arn !== expectedArn)
    throw new CliError(`AWS deploy image ${name} resolves to ${String(arn ?? "no ARN")}, expected ${expectedArn}`);
  const versions =
    awsJson<{ items?: Array<{ imageVersion?: string | number; state?: string; status?: string }> }>(aws, [
      "lambda-microvms",
      "list-microvm-image-versions",
      "--image-identifier",
      expectedArn,
    ]).items ?? [];
  const pinned = versions.find((item) => String(item.imageVersion) === version);
  if (!pinned || pinned.state !== "SUCCESSFUL" || pinned.status !== "ACTIVE") {
    throw new CliError(`AWS deploy image ${name} version ${version} is not SUCCESSFUL and ACTIVE`);
  }
}

function secretValueFrom(config: QmConfig, name: string, arns?: Record<string, string>): string {
  if (arns?.[name]) return arns[name];
  const aws = requireAws(config);
  return `arn:aws:secretsmanager:${aws.region}:${aws.accountId}:secret:${aws.secretsPrefix}${name}`;
}

export function serviceEnvironment(config: QmConfig, service: ServiceName): Record<string, string> {
  const aws = requireAws(config);
  const def = serviceDef(service);
  const coreUrl = `http://core.${aws.networking.cloudMapNamespace}:8080`;
  const coreEnv =
    service === "core"
      ? {
          ...(config.model ? { PI_MODEL: config.model } : {}),
          ...(config.modelProvider ? { MODEL_PROVIDER: config.modelProvider } : {}),
          ...virtualServiceEnv(config.services, config.env),
        }
      : {};
  const env: Record<string, string> = {
    ...orgEnv(service, config.orgId, config.publicUrl, config.services.includes("portal"), brandEnvOf(config)),
    ...(service === "core" ? {} : { CORE_API_URL: coreUrl }),
    ...coreEnv,
    ...hostedServiceEnv(config.services, config.env, service),
    ...(service === "core" ? securityScreenEnv(config) : {}),
  };
  if (service === "core") {
    const sandboxBackend = config.env.core?.SANDBOX_BACKEND?.trim() || config.sandbox?.backend;
    const stores = {
      DEPLOY_PROVIDER: "aws",
      AWS_DEPLOY_REGION: aws.region,
      SESSION_STORE: "postgres",
      RUN_STORE: "postgres",
      SNAPSHOT_STORE: "s3",
      TRANSFER_STORE: "s3",
      S3_BUCKET: config.env.core?.S3_BUCKET?.trim() || awsObjectStoreBucket(config),
      S3_REGION: aws.region,
    };
    if (sandboxBackend && sandboxBackend !== "aws") {
      Object.assign(env, sandboxCoreEnv(config).env, {
        SANDBOX_BACKEND: sandboxBackend,
        ...stores,
      });
    } else {
      Object.assign(env, {
        SANDBOX_BACKEND: "aws",
        AWS_SANDBOX_REGION: aws.region,
        AWS_SANDBOX_IMAGE: config.env.core?.AWS_DEPLOY_IMAGE ?? "",
        AWS_SANDBOX_IMAGE_VERSION: config.env.core?.AWS_DEPLOY_IMAGE_VERSION ?? "",
        AWS_SANDBOX_EXEC_ROLE_ARN:
          config.env.core?.AWS_DEPLOY_EXEC_ROLE_ARN ?? `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-microvm-exec`,
        AWS_SANDBOX_S3_BUCKET: awsObjectStoreBucket(config),
        ...stores,
      });
    }
  }
  if (service === "portal") {
    env.WEB_UI_UPSTREAM = `http://web-ui.${aws.networking.cloudMapNamespace}:8080`;
    env.ADMIN_UPSTREAM = `http://web-ui.${aws.networking.cloudMapNamespace}:8080/admin`;
    env.PORTAL_XFF_TRUSTED_HOPS = "1";
  }
  if (config.services.includes("auth")) {
    Object.assign(
      env,
      brokerWiring(service, {
        publicUrl: config.publicUrl,
        authBaseUrl: `http://auth.${aws.networking.cloudMapNamespace}:8080`,
        ...(config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN
          ? { allowedEmailDomain: config.env.auth.AUTH_ALLOWED_EMAIL_DOMAIN }
          : {}),
      }),
    );
  }
  if (config.services.includes("portal") && (service === "web-ui" || service === "admin")) {
    env.REQUIRE_SIGNED_PORTAL_IDENTITY = "1";
  }
  env[def.docker.portEnv] = String(def.docker.internalPort);
  return Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
}

function workloadEnvironment(config: QmConfig, workload: string): Record<string, string> {
  if (isServiceName(workload)) return serviceEnvironment(config, workload);
  const plugin = config.plugins.find((entry) => entry.name === workload);
  return Object.fromEntries(
    Object.entries({
      ...(plugin?.coreAccess === false
        ? {}
        : { CORE_API_URL: `http://core.${requireAws(config).networking.cloudMapNamespace}:8080` }),
      ...orgEnv(workload, config.orgId, config.publicUrl, config.services.includes("portal"), brandEnvOf(config)),
      ...plugin?.env,
      PORT: "8080",
    }).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function workloadSecrets(config: QmConfig, workload: string, available?: Record<string, string>) {
  const secrets = secretsForService(config, workload).filter(
    (secret) => secret.required || Boolean(available?.[secret.name]),
  );
  const plugin = config.plugins.find((entry) => entry.name === workload);
  if (
    !isServiceName(workload) &&
    plugin?.coreAccess !== false &&
    !secrets.some((secret) => secret.name === "CORE_SIGNING_SECRET")
  ) {
    const signing = computedSecrets(config).find((secret) => secret.name === "CORE_SIGNING_SECRET");
    if (signing) return [...secrets, signing];
  }
  return secrets;
}

function workloadArchitecture(config: QmConfig, workload: string): "arm64" | "amd64" {
  requireAws(config);
  return awsWorkloadArchitecture(config, workload);
}

export function renderTaskDefinition(
  config: QmConfig,
  service: string,
  image: string,
  secretArns?: Record<string, string>,
): EcsTaskDefinition {
  if (!isDigestPinned(image)) throw new CliError(`aws task image for ${service} must be pinned by digest`);
  const aws = requireAws(config);
  const spec = aws.services[service];
  if (!spec) throw new CliError(`aws.services.${service} is missing`);
  const internalPort = isServiceName(service) ? serviceDef(service).docker.internalPort : 8080;
  const executionRoleArn = spec.executionRoleArn ?? `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-task-execution`;
  const managedTaskRole = spec.assumeRoleArns?.length
    ? `${aws.cluster}-${service}-task`
    : `${aws.cluster}-${service === "core" ? "core-task" : "task"}`;
  const taskRoleArn = spec.taskRoleArn ?? `arn:aws:iam::${aws.accountId}:role/${managedTaskRole}`;
  const secrets = workloadSecrets(config, service, secretArns)
    .flatMap((secret) =>
      containerSecretNames(service, secret).map((name) => ({
        name,
        valueFrom: secretValueFrom(config, secret.name, secretArns),
      })),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const healthCheck = isServiceName(service)
    ? {
        command: [
          "CMD",
          "node",
          "-e",
          `fetch('http://127.0.0.1:${internalPort}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
        ],
        interval: 10,
        timeout: 5,
        retries: 3,
        startPeriod: 30,
      }
    : undefined;
  return {
    family: spec.ecsService,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: String(spec.cpu),
    memory: String(spec.memory),
    runtimePlatform: {
      cpuArchitecture: workloadArchitecture(config, service) === "arm64" ? "ARM64" : "X86_64",
      operatingSystemFamily: "LINUX",
    },
    executionRoleArn,
    taskRoleArn,
    containerDefinitions: [
      {
        name: service,
        image,
        essential: true,
        environment: Object.entries(workloadEnvironment(config, service)).map(([name, value]) => ({ name, value })),
        secrets,
        portMappings: [
          {
            name: service,
            containerPort: internalPort,
            hostPort: internalPort,
            protocol: "tcp",
            appProtocol: "http",
          },
        ],
        ...(healthCheck ? { healthCheck } : {}),
        ...(spec.stopTimeout !== undefined ? { stopTimeout: spec.stopTimeout } : {}),
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": spec.logGroup ?? `/ecs/${spec.ecsService}`,
            "awslogs-region": aws.region,
            "awslogs-stream-prefix": service,
          },
        },
      },
    ],
  };
}

function ecrHost(aws: AwsConfig): string {
  return `${aws.accountId}.dkr.ecr.${aws.region}.amazonaws.com`;
}

function expectedWorkloadImageRepository(config: QmConfig, workload: string): string {
  const aws = requireAws(config);
  const repository = aws.services[workload]?.ecrRepository;
  if (!repository) throw new CliError(`aws.services.${workload} is missing`);
  return `${ecrHost(aws)}/${repository}`;
}

export function isPinnedWorkloadImage(config: QmConfig, workload: string, image: string): boolean {
  const repository = expectedWorkloadImageRepository(config, workload).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${repository}@sha256:[0-9a-f]{64}$`).test(image);
}

function dockerLogin(aws: AwsConfig): void {
  const password = awsText(aws, ["ecr", "get-login-password"]);
  const result = spawnSync("docker", ["login", "--username", "AWS", "--password-stdin", ecrHost(aws)], {
    input: `${password}\n`,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new CliError("docker login to ECR failed");
}

function sourceImage(config: QmConfig, service: ServiceName): string {
  return config.imageOverrides[service] ?? manifestRef(service);
}

function workloadSourceImage(
  config: QmConfig,
  workload: string,
  plugin: ResolvedPlugin | undefined,
): string | undefined {
  return (
    plugin?.image ??
    config.plugins.find((entry) => entry.name === workload)?.image ??
    (isServiceName(workload) ? sourceImage(config, workload) : undefined)
  );
}

function workloadImageProvenance(
  config: QmConfig,
  workload: string,
  plugin: ResolvedPlugin | undefined,
  opts: Pick<AwsUpOpts, "buildFrom" | "buildFromPath">,
): DeploymentImageProvenance {
  if (plugin?.kind === "source") {
    return { kind: "source-build", source: "plugin", ...sourceBuildInfo(plugin.sourceDir!) };
  }
  if (opts.buildFrom && isServiceName(workload)) {
    return {
      kind: "source-build",
      source: "checkout",
      ...sourceBuildInfo(resolveBuildRepoRoot(opts.buildFromPath, [workload])),
    };
  }
  const source = workloadSourceImage(config, workload, plugin);
  if (!source) throw new CliError(`AWS workload ${workload} has no source image`);
  return { kind: "configured", source };
}

const sourceBuildInfoByRoot = new Map<string, { gitCommit?: string; dirty?: boolean }>();

function sourceBuildInfo(root: string): { gitCommit?: string; dirty?: boolean } {
  const cached = sourceBuildInfoByRoot.get(root);
  if (cached) return cached;
  const info: { gitCommit?: string; dirty?: boolean } = {};
  try {
    info.gitCommit = capture("git", ["-C", root, "rev-parse", "HEAD"]).trim();
    info.dirty = capture("git", ["-C", root, "status", "--porcelain"]).trim().length > 0;
  } catch {
    void 0;
  }
  sourceBuildInfoByRoot.set(root, info);
  return info;
}

function sourceImageDigest(source: string): string {
  const pinned = source.match(/@(?<digest>sha256:[0-9a-f]{64})$/)?.groups?.digest;
  if (pinned) return pinned;
  const output = capture("docker", ["buildx", "imagetools", "inspect", source]);
  const digest = output.match(/^Digest:\s*(sha256:[0-9a-f]{64})\s*$/m)?.[1];
  if (!digest) throw new CliError(`registry did not return an immutable digest for AWS source image ${source}`);
  return digest;
}

function plannedWorkloadImage(config: QmConfig, workload: string, plugin: ResolvedPlugin | undefined): string {
  const source = workloadSourceImage(config, workload, plugin);
  if (!source) throw new CliError(`AWS workload ${workload} has no source image`);
  return `${expectedWorkloadImageRepository(config, workload)}@${sourceImageDigest(source)}`;
}

function workloadBuildArgs(config: QmConfig, workload: string): Record<string, string> {
  return { ...requireAws(config).services[workload]?.buildArgs };
}

export function imageTransferArgs(source: string, tagged: string): string[] {
  return ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", tagged, source];
}

async function publishWorkloadImage(
  config: QmConfig,
  workload: string,
  plugin: ResolvedPlugin | undefined,
  label: string,
  opts: AwsUpOpts,
  signal?: AbortSignal,
): Promise<string> {
  const aws = requireAws(config);
  const spec = aws.services[workload]!;
  const tagged = `${ecrHost(aws)}/${spec.ecrRepository}:${label}`;
  const platform = `linux/${workloadArchitecture(config, workload)}`;
  if (plugin?.kind === "source") {
    const args = [
      "buildx",
      "build",
      "--platform",
      platform,
      "--provenance=false",
      "--push",
      "-f",
      plugin.dockerfile!,
      "-t",
      tagged,
    ];
    for (const [name, value] of Object.entries(workloadBuildArgs(config, workload)))
      args.push("--build-arg", `${name}=${value}`);
    args.push(plugin.sourceDir!);
    if (signal) await runInheritAsync("docker", args, { signal });
    else runInherit("docker", args);
  } else if (opts.buildFrom && isServiceName(workload)) {
    const root = resolveBuildRepoRoot(opts.buildFromPath, [workload]);
    const dockerfile = join(root, spec.dockerfile ?? join("deploy", workload, "Dockerfile"));
    if (spec.dockerfile && !existsSync(dockerfile)) {
      throw new CliError(`aws.services.${workload}.dockerfile is missing from the build checkout: ${spec.dockerfile}`);
    }
    const args = [
      "buildx",
      "build",
      "--platform",
      platform,
      "--provenance=false",
      "--push",
      "-f",
      dockerfile,
      "-t",
      tagged,
    ];
    const info = sourceBuildInfo(root);
    if (info.gitCommit) args.push("--build-arg", `GIT_SHA=${info.gitCommit}${info.dirty ? "-dirty" : ""}`);
    for (const [name, value] of Object.entries(workloadBuildArgs(config, workload)))
      args.push("--build-arg", `${name}=${value}`);
    args.push(root);
    if (signal) await runInheritAsync("docker", args, { signal });
    else runInherit("docker", args);
  } else {
    const source = workloadSourceImage(config, workload, plugin);
    if (!source) throw new CliError(`AWS workload ${workload} has no source image`);
    if (signal) await runInheritAsync("docker", imageTransferArgs(source, tagged), { signal });
    else runInherit("docker", imageTransferArgs(source, tagged));
  }
  const response = awsJson<{ imageDetails?: Array<{ imageDigest?: string }> }>(aws, [
    "ecr",
    "describe-images",
    "--repository-name",
    spec.ecrRepository,
    "--image-ids",
    `imageTag=${label}`,
  ]);
  const digest = response.imageDetails?.[0]?.imageDigest;
  if (!digest) throw new CliError(`ECR did not return a digest for ${tagged}`);
  return `${ecrHost(aws)}/${spec.ecrRepository}@${digest}`;
}

function releaseCandidate(config: QmConfig, path: string): AwsReleaseCandidate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`could not read AWS release candidate ${path}: ${errMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`AWS release candidate ${path} is not an object`);
  }
  const candidate = parsed as Partial<AwsReleaseCandidate>;
  const aws = requireAws(config);
  if (
    candidate.contract !== 1 ||
    candidate.accountId !== aws.accountId ||
    candidate.region !== aws.region ||
    typeof candidate.label !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(candidate.label) ||
    !candidate.images ||
    typeof candidate.images !== "object" ||
    Array.isArray(candidate.images) ||
    !candidate.imageProvenance ||
    typeof candidate.imageProvenance !== "object" ||
    Array.isArray(candidate.imageProvenance)
  ) {
    throw new CliError(`AWS release candidate ${path} has an invalid contract or targets another AWS account/region`);
  }
  for (const [workload, image] of Object.entries(candidate.images)) {
    const provenance = candidate.imageProvenance[workload];
    const validProvenance =
      provenance?.kind === "configured"
        ? typeof provenance.source === "string"
        : provenance?.kind === "source-build" &&
          (provenance.source === undefined || provenance.source === "plugin" || provenance.source === "checkout") &&
          (provenance.gitCommit === undefined || typeof provenance.gitCommit === "string") &&
          (provenance.dirty === undefined || typeof provenance.dirty === "boolean");
    if (
      !aws.services[workload] ||
      typeof image !== "string" ||
      !isPinnedWorkloadImage(config, workload, image) ||
      !validProvenance
    ) {
      throw new CliError(`AWS release candidate ${path} has an invalid ${workload} image or provenance`);
    }
  }
  return candidate as AwsReleaseCandidate;
}

export async function awsMigrateCandidate(config: QmConfig, configDir: string, candidatePath: string): Promise<void> {
  const { aws, workloads } = awsTopology(config, configDir);
  if (!workloads.includes("core")) throw new CliError("AWS migrations require the core workload");
  const candidate = releaseCandidate(config, candidatePath);
  const coreImage = candidate.images.core;
  if (!coreImage) throw new CliError(`AWS release candidate ${candidatePath} does not contain core`);
  assertAwsCallerAccount(aws);
  await withAwsLease(aws, async () => {
    if (aws.predeployDbSnapshot === false)
      note("pre-migration database restore point: disabled (aws.predeployDbSnapshot)");
    else assertPredeployDbRestorePoint(config);
    await runAwsCandidateMigration(config, coreImage, candidate.label);
  });
}

async function runAwsCandidateMigration(config: QmConfig, coreImage: string, label: string): Promise<void> {
  const aws = requireAws(config);
  const spec = aws.services.core;
  if (!spec) throw new CliError("AWS migrations require the core workload");
  const service = awsJson<{ services?: AwsMigrationService[]; failures?: Array<{ arn?: string; reason?: string }> }>(
    aws,
    ["ecs", "describe-services", "--cluster", aws.cluster, "--services", spec.ecsService],
  );
  if (service.failures?.length || service.services?.[0]?.status !== "ACTIVE") {
    throw new CliError(`AWS core service ${spec.ecsService} is not active`);
  }
  const live = service.services[0]!;
  const network = live.networkConfiguration?.awsvpcConfiguration;
  if (
    live.launchType !== "FARGATE" ||
    !network?.subnets?.length ||
    !network.securityGroups?.length ||
    (network.assignPublicIp !== "ENABLED" && network.assignPublicIp !== "DISABLED")
  ) {
    throw new CliError(`AWS core service ${spec.ecsService} does not expose a reusable Fargate network configuration`);
  }
  const temp = mkdtempSync(join(tmpdir(), "qm-migration-task-"));
  let taskDefinition: string | undefined;
  try {
    const definitionPath = join(temp, "core.json");
    const definition = renderTaskDefinition(config, "core", coreImage, secretArns(config));
    const container = definition.containerDefinitions.find((candidate) => candidate.name === "core");
    if (!container) throw new CliError("AWS migration task definition has no core container");
    delete container.healthCheck;
    writeFileSync(definitionPath, JSON.stringify(definition));
    taskDefinition = registerTaskDefinition(config, definitionPath);
    header(`qm migrate — ${config.orgId} (AWS candidate ${label})`);
    const started = awsJson<{
      tasks?: Array<{ taskArn?: string }>;
      failures?: Array<{ arn?: string; reason?: string; detail?: string }>;
    }>(aws, [
      "ecs",
      "run-task",
      "--cluster",
      aws.cluster,
      "--task-definition",
      taskDefinition,
      "--launch-type",
      "FARGATE",
      ...(live.platformVersion ? ["--platform-version", live.platformVersion] : []),
      "--network-configuration",
      JSON.stringify({ awsvpcConfiguration: network }),
      "--overrides",
      JSON.stringify({ containerOverrides: [{ name: "core", command: ["node", "src/migrate-main.ts"] }] }),
      "--started-by",
      "qm-migration",
    ]);
    const taskArn = started.tasks?.[0]?.taskArn;
    if (!taskArn || started.failures?.length) {
      const failures = started.failures
        ?.map((failure) => `${failure.arn ?? "unknown"}: ${failure.reason ?? failure.detail ?? "unknown"}`)
        .join(", ");
      throw new CliError(`AWS could not start the migration task${failures ? ` (${failures})` : ""}`);
    }
    step(`migration task: ${taskArn}`);
    awsText(aws, ["ecs", "wait", "tasks-stopped", "--cluster", aws.cluster, "--tasks", taskArn]);
    const stopped = awsJson<{
      tasks?: Array<{
        stoppedReason?: string;
        containers?: Array<{ name?: string; exitCode?: number; reason?: string }>;
      }>;
      failures?: Array<{ arn?: string; reason?: string }>;
    }>(aws, ["ecs", "describe-tasks", "--cluster", aws.cluster, "--tasks", taskArn]);
    const task = stopped.tasks?.[0];
    const core = task?.containers?.find((container) => container.name === "core");
    if (stopped.failures?.length || core?.exitCode !== 0) {
      throw new CliError(
        `AWS migration task failed (${core?.reason ?? task?.stoppedReason ?? `exit ${core?.exitCode ?? "unknown"}`})`,
      );
    }
    ok(`candidate ${label} migrations applied`);
  } finally {
    if (taskDefinition) {
      try {
        awsText(aws, ["ecs", "deregister-task-definition", "--task-definition", taskDefinition]);
      } catch (error) {
        warn(`could not deregister migration task definition ${taskDefinition}: ${errMessage(error)}`);
      }
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

export function secretArns(config: QmConfig): Record<string, string> {
  const aws = requireAws(config);
  const pairs = computedSecrets(config).flatMap((secret) => {
    const id = `${aws.secretsPrefix}${secret.name}`;
    try {
      if (!secret.required) {
        const metadata = awsJson<{
          ARN?: string;
          DeletedDate?: string;
          VersionIdsToStages?: Record<string, string[]>;
        }>(aws, ["secretsmanager", "describe-secret", "--secret-id", id]);
        const hasCurrent = Object.values(metadata.VersionIdsToStages ?? {}).some((stages) =>
          stages.includes("AWSCURRENT"),
        );
        return metadata.ARN && !metadata.DeletedDate && hasCurrent ? [[secret.name, metadata.ARN] as const] : [];
      }
      const value = awsJson<{ ARN?: string; SecretString?: string }>(aws, [
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        id,
      ]);
      if (!value.ARN || isInvalidSecret(secret.name, value.SecretString)) {
        throw new CliError(`required AWS secret ${secret.name} has no usable, non-placeholder AWSCURRENT value`);
      }
      return [[secret.name, value.ARN] as const];
    } catch (error) {
      if (!secret.required && /ResourceNotFoundException/.test(errMessage(error))) return [];
      throw error;
    }
  });
  return Object.fromEntries(pairs);
}

function assertAwsPublicApiUrl(config: QmConfig): void {
  if (!computedSecrets(config).some((secret) => secret.name === "PUBLIC_API_URL")) return;
  const aws = requireAws(config);
  const value = awsText(aws, [
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    `${aws.secretsPrefix}PUBLIC_API_URL`,
    "--query",
    "SecretString",
  ]);
  const bound = config.apiUrl ? ("apiUrl" as const) : ("publicUrl" as const);
  const expected = new URL(config.apiUrl ?? config.publicUrl).toString().replace(/\/$/, "");
  let normalized: string;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new Error("not HTTPS");
    normalized = parsed.toString().replace(/\/$/, "");
  } catch {
    throw new CliError(`required AWS secret PUBLIC_API_URL must be a valid HTTPS URL equal to the configured ${bound}`);
  }
  if (normalized !== expected) {
    throw new CliError(`required AWS secret PUBLIC_API_URL must equal the configured HTTPS ${bound} (${expected})`);
  }
}

function liveTask(config: QmConfig, service: string): Record<string, unknown> | null {
  const aws = requireAws(config);
  const spec = aws.services[service]!;
  const described = awsJson<{ services?: Array<{ taskDefinition?: string }> }>(aws, [
    "ecs",
    "describe-services",
    "--cluster",
    aws.cluster,
    "--services",
    spec.ecsService,
  ]);
  const arn = described.services?.[0]?.taskDefinition;
  if (!arn) return null;
  return (
    awsJson<{ taskDefinition?: Record<string, unknown> }>(aws, [
      "ecs",
      "describe-task-definition",
      "--task-definition",
      arn,
    ]).taskDefinition ?? null
  );
}

function normalizeLiveTask(task: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!task) return null;
  const copy = structuredClone(task);
  for (const key of [
    "taskDefinitionArn",
    "revision",
    "status",
    "requiresAttributes",
    "compatibilities",
    "registeredAt",
    "registeredBy",
    "deregisteredAt",
  ])
    delete copy[key];
  for (const key of ["volumes", "placementConstraints"] as const) {
    if (Array.isArray(copy[key]) && copy[key].length === 0) delete copy[key];
  }
  if (copy.enableFaultInjection === false) delete copy.enableFaultInjection;
  const containers = copy.containerDefinitions;
  if (Array.isArray(containers)) {
    for (const value of containers) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const container = value as Record<string, unknown>;
      if (container.cpu === 0) delete container.cpu;
      for (const key of ["mountPoints", "volumesFrom", "systemControls", "resourceRequirements", "ulimits"] as const) {
        if (Array.isArray(container[key]) && container[key].length === 0) delete container[key];
      }
      for (const key of ["environment", "secrets", "portMappings"] as const) {
        if (Array.isArray(container[key])) {
          container[key] = [...container[key]].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
        }
      }
    }
  }
  if (Array.isArray(copy.requiresCompatibilities)) copy.requiresCompatibilities.sort();
  return copy;
}

function taskReviewShape(task: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeLiveTask(task)!;
  const values = Array.isArray(normalized.containerDefinitions) ? normalized.containerDefinitions : [];
  normalized.containerDefinitions = Object.fromEntries(
    values.map((value) => {
      const container = value as Record<string, unknown>;
      const shaped = { ...container };
      for (const field of ["environment", "secrets"] as const) {
        const entries = Array.isArray(shaped[field]) ? (shaped[field] as Array<Record<string, unknown>>) : [];
        shaped[field] = Object.fromEntries(
          entries.map((entry) => [String(entry.name), field === "environment" ? entry.value : entry.valueFrom]),
        );
      }
      return [String(container.name), shaped];
    }),
  );
  return normalized;
}

export interface TaskDefinitionChange {
  path: string;
  live: unknown;
  desired: unknown;
}

function diffTaskValues(desired: unknown, live: unknown, path: string, out: TaskDefinitionChange[]): void {
  if (canonicalJson(desired) === canonicalJson(live)) return;
  if (
    desired &&
    live &&
    typeof desired === "object" &&
    typeof live === "object" &&
    !Array.isArray(desired) &&
    !Array.isArray(live)
  ) {
    const expected = desired as Record<string, unknown>;
    const actual = live as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      diffTaskValues(expected[key], actual[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push({
    path,
    live: live === undefined ? "<absent>" : live,
    desired: desired === undefined ? "<absent>" : desired,
  });
}

export function taskDefinitionChanges(
  desired: EcsTaskDefinition,
  live: Record<string, unknown> | null,
): TaskDefinitionChange[] {
  const out: TaskDefinitionChange[] = [];
  diffTaskValues(
    taskReviewShape(desired as unknown as Record<string, unknown>),
    live ? taskReviewShape(live) : null,
    "taskDefinition",
    out,
  );
  return out;
}

export function taskDefinitionDiff(desired: EcsTaskDefinition, live: Record<string, unknown> | null): string[] {
  return taskDefinitionChanges(desired, live).map((change) => change.path);
}

interface EcsDeploymentState {
  id?: string;
  status?: string;
  taskDefinition?: string;
  rolloutState?: string;
  runningCount?: number;
  failedTasks?: number;
}

interface EcsServiceState {
  serviceName?: string;
  status?: string;
  desiredCount?: number;
  runningCount?: number;
  taskDefinition?: string;
  deploymentConfiguration?: { strategy?: string };
  networkConfiguration?: {
    awsvpcConfiguration?: {
      subnets?: string[];
      securityGroups?: string[];
      assignPublicIp?: "ENABLED" | "DISABLED";
    };
  };
  deployments?: EcsDeploymentState[];
  tags?: Array<{ key?: string; value?: string }>;
}

interface EcsServiceDeploymentSummary {
  targetServiceRevisionArn?: string;
  status?: string;
  createdAt?: string | number;
}

interface EcsServiceRevision {
  serviceRevisionArn?: string;
  taskDefinition?: string;
}

function awsLiveSession(config: QmConfig, core: EcsServiceState): void {
  const aws = requireAws(config);
  if (!core.taskDefinition) throw new Error("core service has no live task definition");
  if (!core.networkConfiguration?.awsvpcConfiguration) throw new Error("core service has no VPC network configuration");
  const taskArns =
    awsJson<{ taskArns?: string[] }>(aws, [
      "ecs",
      "list-tasks",
      "--cluster",
      aws.cluster,
      "--service-name",
      aws.services.core!.ecsService,
      "--desired-status",
      "RUNNING",
    ]).taskArns ?? [];
  if (!taskArns.length) throw new Error("core service has no running tasks for the private canary");
  let address: string | undefined;
  for (let offset = 0; offset < taskArns.length && !address; offset += 100) {
    const tasks =
      awsJson<{
        tasks?: Array<{
          taskDefinitionArn?: string;
          lastStatus?: string;
          healthStatus?: string;
          containers?: Array<{ name?: string; networkInterfaces?: Array<{ privateIpv4Address?: string }> }>;
        }>;
      }>(aws, ["ecs", "describe-tasks", "--cluster", aws.cluster, "--tasks", ...taskArns.slice(offset, offset + 100)])
        .tasks ?? [];
    address = tasks
      .filter(
        (task) =>
          task.taskDefinitionArn === core.taskDefinition &&
          task.lastStatus === "RUNNING" &&
          task.healthStatus !== "UNHEALTHY",
      )
      .flatMap((task) => task.containers?.filter((container) => container.name === "core") ?? [])
      .flatMap((container) => container.networkInterfaces ?? [])
      .find((network) => network.privateIpv4Address)?.privateIpv4Address;
  }
  if (!address) throw new Error("core service has no current running task with a private IPv4 address");
  const started = awsJson<{
    tasks?: Array<{ taskArn?: string }>;
    failures?: Array<{ arn?: string; reason?: string; detail?: string }>;
  }>(aws, [
    "ecs",
    "run-task",
    "--cluster",
    aws.cluster,
    "--task-definition",
    core.taskDefinition,
    "--launch-type",
    "FARGATE",
    "--network-configuration",
    JSON.stringify(core.networkConfiguration),
    "--overrides",
    JSON.stringify({
      containerOverrides: [
        {
          name: "core",
          command: ["node", "src/deployment/postdeploy-smoke.ts", "session", `http://${address}:8080`],
        },
      ],
    }),
    "--count",
    "1",
  ]);
  const taskArn = started.tasks?.[0]?.taskArn;
  if (!taskArn) {
    const failure = started.failures?.[0];
    throw new Error(
      `could not start canary task: ${failure?.reason ?? failure?.detail ?? failure?.arn ?? "no task returned"}`,
    );
  }
  awsText(aws, ["ecs", "wait", "tasks-stopped", "--cluster", aws.cluster, "--tasks", taskArn]);
  const stopped = awsJson<{
    tasks?: Array<{
      stoppedReason?: string;
      containers?: Array<{ name?: string; exitCode?: number; reason?: string }>;
    }>;
  }>(aws, ["ecs", "describe-tasks", "--cluster", aws.cluster, "--tasks", taskArn]);
  const task = stopped.tasks?.[0];
  const coreContainer = task?.containers?.find((container) => container.name === "core");
  if (coreContainer?.exitCode !== 0) {
    throw new Error(
      `canary task exited ${coreContainer?.exitCode ?? "without a code"}: ${coreContainer?.reason ?? task?.stoppedReason ?? "unknown reason"}`,
    );
  }
}

type DeploymentImageProvenance =
  | { kind: "configured"; source: string }
  | { kind: "source-build"; source?: "plugin" | "checkout"; gitCommit?: string; dirty?: boolean };

interface AwsReleaseCandidate {
  contract: 1;
  accountId: string;
  region: string;
  label: string;
  images: Record<string, string>;
  imageProvenance: Record<string, DeploymentImageProvenance>;
}

interface DeploymentManifest {
  id: string;
  previous?: string;
  createdAt: string;
  imageLabel?: string;
  dbSnapshot?: string;
  dbRestorePoint?: string;
  tasks: Record<string, string>;
  counts?: Record<string, number>;
  imageProvenance?: Record<string, DeploymentImageProvenance>;
  layer?: { key: string; sha256: string };
}

const DEPLOYMENT_POINTER_KEY = "deployment/current";
const DEPLOYMENT_MANIFEST_PREFIX = "deployment/manifest/";
const ECS_SERVICE_BATCH_SIZE = 10;

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function describedServices(config: QmConfig, workloads: string[]): Map<string, EcsServiceState> {
  const aws = requireAws(config);
  const byEcsName = new Map(workloads.map((name) => [aws.services[name]!.ecsService, name]));
  const out = new Map<string, EcsServiceState>();
  const failures: string[] = [];
  for (const batch of chunks([...byEcsName.keys()], ECS_SERVICE_BATCH_SIZE)) {
    const response = awsJson<{
      services?: EcsServiceState[];
      failures?: Array<{ arn?: string; reason?: string; detail?: string }>;
    }>(aws, ["ecs", "describe-services", "--cluster", aws.cluster, "--include", "TAGS", "--services", ...batch]);
    for (const service of response.services ?? []) {
      const workload = service.serviceName ? byEcsName.get(service.serviceName) : undefined;
      if (workload) out.set(workload, service);
    }
    for (const failure of response.failures ?? []) {
      failures.push(`${failure.arn ?? "unknown service"}: ${failure.reason ?? failure.detail ?? "describe failed"}`);
    }
  }
  for (const workload of workloads) {
    if (!out.has(workload))
      failures.push(`${aws.services[workload]!.ecsService}: missing from DescribeServices response`);
  }
  if (failures.length)
    throw new CliError(`could not describe AWS services:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  return out;
}

function nativeBlueGreenStatus(
  config: QmConfig,
  workload: string,
  taskDefinition: string | undefined,
): string | undefined {
  if (!taskDefinition) return undefined;
  const aws = requireAws(config);
  const listed = awsJson<{ serviceDeployments?: EcsServiceDeploymentSummary[] }>(aws, [
    "ecs",
    "list-service-deployments",
    "--cluster",
    aws.cluster,
    "--service",
    aws.services[workload]!.ecsService,
  ]);
  const deployments = listed.serviceDeployments ?? [];
  const revisionArns = deployments.flatMap((deployment) =>
    deployment.targetServiceRevisionArn ? [deployment.targetServiceRevisionArn] : [],
  );
  if (!revisionArns.length) return undefined;
  const described = awsJson<{ serviceRevisions?: EcsServiceRevision[] }>(aws, [
    "ecs",
    "describe-service-revisions",
    "--service-revision-arns",
    ...revisionArns,
  ]);
  const tasksByRevision = new Map(
    (described.serviceRevisions ?? []).flatMap((revision) =>
      revision.serviceRevisionArn && revision.taskDefinition
        ? [[revision.serviceRevisionArn, revision.taskDefinition] as const]
        : [],
    ),
  );
  const timestamp = (deployment: EcsServiceDeploymentSummary): number =>
    typeof deployment.createdAt === "number" ? deployment.createdAt : Date.parse(deployment.createdAt ?? "") || 0;
  return deployments
    .filter(
      (deployment) =>
        deployment.targetServiceRevisionArn &&
        tasksByRevision.get(deployment.targetServiceRevisionArn) === taskDefinition,
    )
    .sort((a, b) => timestamp(b) - timestamp(a))[0]?.status;
}

function assertOwnedServices(config: QmConfig, states: Map<string, EcsServiceState>, workloads: string[]): void {
  for (const workload of workloads) {
    const service = states.get(workload)!;
    const tags = Object.fromEntries(
      (service.tags ?? []).flatMap((tag) => (tag.key && tag.value ? [[tag.key, tag.value] as const] : [])),
    );
    if (tags["Deployment"] !== config.orgId || tags["ManagedBy"] !== "terraform") {
      throw new CliError(
        `refusing to mutate ${service.serviceName ?? workload}: ownership tags do not match deployment ${config.orgId}`,
      );
    }
  }
}

interface RolloutTarget {
  taskDefinition: string;
  desiredCount: number;
  deploymentId?: string;
  waitForDrain?: boolean;
}

async function awaitServiceTargets(
  config: QmConfig,
  expected: Record<string, RolloutTarget>,
  timeoutMs?: number,
): Promise<void> {
  const pollMs = envNum("QM_AWS_ROLLOUT_POLL_MS", 15_000);
  const deadline = Date.now() + (timeoutMs ?? envNum("QM_AWS_ROLLOUT_DEADLINE_MS", 20 * 60_000));
  let healthyStreak = 0;
  let failurePolls = new Map<string, number>();
  let describeFailures = 0;
  const failing = new Map<string, { polls: number; baseRunning: number }>();
  for (;;) {
    let states: ReadonlyMap<string, EcsServiceState>;
    let nativeStatuses: ReadonlyMap<string, string | undefined>;
    try {
      states = describedServices(config, Object.keys(expected));
      nativeStatuses = new Map(
        Object.entries(expected).flatMap(([workload, want]) =>
          states.get(workload)?.deploymentConfiguration?.strategy === "BLUE_GREEN"
            ? [[workload, nativeBlueGreenStatus(config, workload, want.taskDefinition)] as const]
            : [],
        ),
      );
      describeFailures = 0;
    } catch (error) {
      describeFailures += 1;
      if (describeFailures > 2 || Date.now() > deadline) throw error;
      note(`could not poll AWS services (${errMessage(error)}); retrying`);
      await sleep(pollMs);
      continue;
    }
    const failures: Array<{ identity: string; message: string }> = [];
    const fail = (workload: string, kind: string, message: string): void =>
      void failures.push({ identity: `${workload}:${kind}`, message });
    const waiting: string[] = [];
    let draining = 0;
    const failingNow = new Set<string>();
    for (const [workload, want] of Object.entries(expected)) {
      const state = states.get(workload)!;
      const primary = (state.deployments ?? []).filter((deployment) => deployment.status === "PRIMARY");
      const deployment = primary[0];
      const running = deployment?.runningCount ?? 0;
      if (state.status !== "ACTIVE") {
        fail(workload, "service-status", `${workload}: service is ${state.status ?? "missing"}`);
      } else if (
        state.taskDefinition !== want.taskDefinition ||
        primary.length !== 1 ||
        deployment?.taskDefinition !== want.taskDefinition
      ) {
        fail(
          workload,
          "task-definition",
          `${workload}: requested task definition is not the sole PRIMARY deployment (service runs ${state.taskDefinition ?? "no task"} — an ECS circuit-breaker rollback or a concurrent deploy)`,
        );
      } else if (want.deploymentId !== undefined && deployment.id !== want.deploymentId) {
        fail(
          workload,
          "deployment-id",
          `${workload}: PRIMARY deployment is ${deployment.id ?? "unknown"}, expected ${want.deploymentId}`,
        );
      } else if (deployment.rolloutState === "FAILED") {
        fail(
          workload,
          "rollout-failed",
          `${workload}: PRIMARY rollout is FAILED (failedTasks=${deployment.failedTasks ?? 0} — an ECS circuit-breaker abort)`,
        );
      } else if (state.desiredCount !== want.desiredCount) {
        fail(
          workload,
          "desired-count",
          `${workload}: ${state.desiredCount ?? 0} desired, expected ${want.desiredCount}`,
        );
      } else if ((deployment.failedTasks ?? 0) > 0 && running < want.desiredCount) {
        failingNow.add(workload);
        const tracked = failing.get(workload);
        if (!tracked || running > tracked.baseRunning) failing.set(workload, { polls: 1, baseRunning: running });
        else tracked.polls += 1;
        const streak = failing.get(workload)!;
        if (streak.polls >= 4) {
          fail(
            workload,
            "failed-tasks",
            `${workload}: PRIMARY deployment keeps failing tasks with no replacement starting (failedTasks=${deployment.failedTasks}, ${running}/${want.desiredCount} running across ${streak.polls} polls)`,
          );
        } else {
          waiting.push(
            `${workload} (${running}/${want.desiredCount}, ${deployment.failedTasks} failed; awaiting replacement)`,
          );
        }
      } else if (running < want.desiredCount) {
        waiting.push(`${workload} (${running}/${want.desiredCount})`);
      } else if (
        want.waitForDrain &&
        (deployment.rolloutState !== "COMPLETED" || state.deployments?.length !== 1) &&
        state.deploymentConfiguration?.strategy !== "BLUE_GREEN"
      ) {
        waiting.push(`${workload} (prior tasks are still draining)`);
      } else if (state.deploymentConfiguration?.strategy === "BLUE_GREEN") {
        const nativeStatus = nativeStatuses.get(workload);
        if (nativeStatus === "SUCCESSFUL") continue;
        if (nativeStatus && nativeStatus !== "PENDING" && nativeStatus !== "IN_PROGRESS") {
          fail(workload, "native-blue-green", `${workload}: native blue/green deployment is ${nativeStatus}`);
        } else {
          waiting.push(`${workload} (blue/green traffic shift or bake is still in progress)`);
        }
      } else if (deployment.rolloutState !== "COMPLETED") {
        draining += 1;
      }
    }
    for (const workload of failing.keys()) {
      if (!failingNow.has(workload)) failing.delete(workload);
    }
    if (failures.length) {
      healthyStreak = 0;
      const next = new Map<string, number>();
      const confirmed: string[] = [];
      for (const failure of failures) {
        const polls = (failurePolls.get(failure.identity) ?? 0) + 1;
        next.set(failure.identity, polls);
        if (polls >= 2) confirmed.push(failure.message);
      }
      failurePolls = next;
      if (confirmed.length || Date.now() > deadline) {
        const fatal = confirmed.length ? confirmed : failures.map((failure) => failure.message);
        throw new CliError(
          `AWS deployment did not reach the requested state:\n${fatal.map((failure) => `  - ${failure}`).join("\n")}`,
        );
      }
      note(`possible rollout failure; confirming: ${failures.map((failure) => failure.message).join("; ")}`);
      await sleep(pollMs);
      continue;
    }
    failurePolls = new Map();
    if (waiting.length === 0) {
      if (draining === 0) return;
      healthyStreak += 1;
      if (healthyStreak >= 3) return;
    } else {
      healthyStreak = 0;
    }
    if (Date.now() > deadline) {
      throw new CliError(
        `timed out waiting for the AWS rollout: ${waiting.length ? `still starting ${waiting.join(", ")}` : "confirming health while old tasks drain"}`,
      );
    }
    note(
      waiting.length
        ? `waiting on ${waiting.join(", ")}`
        : `new tasks healthy; old task(s) still draining protected turns (${healthyStreak}/3)`,
    );
    await sleep(pollMs);
  }
}

function dynamoString(item: Record<string, { S?: string }> | undefined, name: string): string | undefined {
  return item?.[name]?.S;
}

function deploymentManifest(aws: AwsConfig, id: string): DeploymentManifest {
  const response = awsJson<{ Item?: Record<string, { S?: string }> }>(aws, [
    "dynamodb",
    "get-item",
    "--table-name",
    deployLocksTable(aws),
    "--key",
    JSON.stringify({ lockKey: { S: `${DEPLOYMENT_MANIFEST_PREFIX}${id}` } }),
    "--consistent-read",
  ]);
  const raw = dynamoString(response.Item, "manifest");
  if (!raw) throw new CliError(`AWS deployment manifest ${id} is missing`);
  try {
    return JSON.parse(raw) as DeploymentManifest;
  } catch {
    throw new CliError(`AWS deployment manifest ${id} is invalid`);
  }
}

function currentDeploymentManifest(aws: AwsConfig): DeploymentManifest | undefined {
  return deploymentManifestAtPointer(aws, DEPLOYMENT_POINTER_KEY);
}

function deploymentManifestAtPointer(aws: AwsConfig, key: string): DeploymentManifest | undefined {
  const response = awsJson<{ Item?: Record<string, { S?: string }> }>(aws, [
    "dynamodb",
    "get-item",
    "--table-name",
    deployLocksTable(aws),
    "--key",
    JSON.stringify({ lockKey: { S: key } }),
    "--consistent-read",
  ]);
  const id = dynamoString(response.Item, "manifestId");
  return id ? deploymentManifest(aws, id) : undefined;
}

function manifestTransaction(aws: AwsConfig, manifest: DeploymentManifest | undefined, pointerId: string): void {
  const table = deployLocksTable(aws);
  const writes: unknown[] = [];
  if (manifest) {
    writes.push({
      Put: {
        TableName: table,
        Item: {
          lockKey: { S: `${DEPLOYMENT_MANIFEST_PREFIX}${manifest.id}` },
          manifest: { S: JSON.stringify(manifest) },
        },
      },
    });
    if (manifest.imageLabel)
      writes.push({
        Put: {
          TableName: table,
          Item: {
            lockKey: { S: `deployment/label/${manifest.imageLabel}` },
            manifestId: { S: manifest.id },
          },
        },
      });
  }
  writes.push({
    Put: {
      TableName: table,
      Item: {
        lockKey: { S: DEPLOYMENT_POINTER_KEY },
        manifestId: { S: pointerId },
      },
    },
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      awsText(aws, ["dynamodb", "transact-write-items", "--transact-items", JSON.stringify(writes)]);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new CliError(
    `AWS deployment manifest write failed: ${errMessage(lastError)}; run \`qm check --live\` to establish the current manifest before deploying again`,
  );
}

function deploymentManifestForTarget(aws: AwsConfig, target: string): DeploymentManifest {
  const labeled = deploymentManifestAtPointer(aws, `deployment/label/${target}`);
  return labeled ?? deploymentManifest(aws, target);
}

function recordDeploymentManifest(
  aws: AwsConfig,
  tasks: Record<string, string>,
  release: {
    id?: string;
    imageLabel?: string;
    dbRestorePoint?: string;
    layer?: DeploymentManifest["layer"];
    imageProvenance?: DeploymentManifest["imageProvenance"];
    counts?: DeploymentManifest["counts"];
  },
): DeploymentManifest {
  const current = currentDeploymentManifest(aws);
  const counts = release.counts ?? current?.counts;
  const manifest: DeploymentManifest = {
    id: release.id ?? randomUUID(),
    ...(current ? { previous: current.id } : {}),
    createdAt: new Date().toISOString(),
    ...(release.imageLabel ? { imageLabel: release.imageLabel } : {}),
    ...(release.dbRestorePoint ? { dbRestorePoint: release.dbRestorePoint } : {}),
    tasks,
    ...(counts ? { counts } : {}),
    ...(release.imageProvenance ? { imageProvenance: release.imageProvenance } : {}),
    ...(release.layer ? { layer: release.layer } : {}),
  };
  manifestTransaction(aws, manifest, manifest.id);
  return manifest;
}

function putDeploymentLayerArtifact(config: QmConfig, body: string): NonNullable<DeploymentManifest["layer"]> {
  if (Buffer.byteLength(body) > 1_000_000)
    throw new CliError("deployment layer exceeds the core API's 1 MB request limit");
  const aws = requireAws(config);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const key = `deployment/layers/${sha256}.json`;
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-"));
  const file = join(dir, "layer.json");
  try {
    writeFileSync(file, body);
    awsText(aws, ["s3api", "put-object", "--bucket", awsObjectStoreBucket(config), "--key", key, "--body", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { key, sha256 };
}

function getDeploymentLayerArtifact(config: QmConfig, layer: DeploymentManifest["layer"]): string {
  if (!layer) throw new CliError("target AWS deployment manifest has no restorable deployment layer");
  const aws = requireAws(config);
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-"));
  const file = join(dir, "layer.json");
  try {
    awsText(aws, ["s3api", "get-object", "--bucket", awsObjectStoreBucket(config), "--key", layer.key, file]);
    const body = readFileSync(file, "utf8");
    if (Buffer.byteLength(body) > 1_000_000 || createHash("sha256").update(body).digest("hex") !== layer.sha256) {
      throw new CliError("AWS deployment-layer artifact is invalid or does not match its manifest");
    }
    return body;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertAwsLayerApplied(
  result: DeploymentLayerSyncResult | undefined,
  expected: NonNullable<DeploymentManifest["layer"]> | string,
): void {
  const expectedHash = typeof expected === "string" ? expected : expected.sha256;
  if (!result || result.status === "degraded" || result.durable !== true || result.contentHash !== expectedHash) {
    throw new CliError("AWS deployment layer was not durably applied with the expected content hash");
  }
}

async function retryLiveProbe<T>(probe: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + envNum("QM_AWS_LIVE_PROBE_DEADLINE_MS", 2 * 60_000);
  for (;;) {
    try {
      return await probe();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      note(`live probe failed (${errMessage(error)}); retrying while old tasks drain`);
      await sleep(envNum("QM_AWS_LIVE_PROBE_POLL_MS", 5_000));
    }
  }
}

async function syncAwsLayerAfterRoll(
  args: Parameters<typeof syncDeploymentLayerBody>[0],
  body: string,
  expected: NonNullable<DeploymentManifest["layer"]> | string,
): Promise<void> {
  await retryLiveProbe(async () => {
    assertAwsLayerApplied(await syncDeploymentLayerBody(args, body), expected);
  });
}

function throwAfterCompensation(error: unknown, failures: string[]): never {
  if (failures.length) throw new CliError(`${errMessage(error)}; compensation also failed (${failures.join("; ")})`);
  throw error;
}

function workloadDesiredCount(config: QmConfig, workload: string): number {
  return requireAws(config).services[workload]?.desiredCount ?? 1;
}

function serviceSnapshot(
  config: QmConfig,
  workloads: string[],
): {
  tasks: Record<string, string>;
  counts: Record<string, number>;
} {
  return serviceSnapshotFromStates(describedServices(config, workloads), workloads);
}

function serviceSnapshotFromStates(
  states: ReadonlyMap<string, EcsServiceState>,
  workloads: string[],
): ReturnType<typeof serviceSnapshot> {
  const tasks: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const workload of workloads) {
    const state = states.get(workload)!;
    if (!state.taskDefinition) throw new CliError(`${workload}: ECS service has no task definition`);
    tasks[workload] = state.taskDefinition;
    counts[workload] = state.desiredCount ?? 0;
  }
  return { tasks, counts };
}

function trustedDeploymentBaseline(
  config: QmConfig,
  snapshot: ReturnType<typeof serviceSnapshot>,
  workloads: string[],
  action = "deploy --only",
): DeploymentManifest {
  const aws = requireAws(config);
  const current = currentDeploymentManifest(aws);
  if (!current || workloads.some((workload) => !current.tasks[workload])) {
    throw new CliError(
      "the first AWS deployment must include every workload; omit --only until a complete deployment manifest exists",
    );
  }
  for (const workload of workloads) {
    if (
      snapshot.tasks[workload] !== current.tasks[workload] ||
      snapshot.counts[workload] !== workloadDesiredCount(config, workload)
    ) {
      throw new CliError(
        `cannot ${action} while untouched workload ${workload} differs from the current deployment manifest`,
      );
    }
    const task = awsJson<{ taskDefinition?: Record<string, unknown> }>(aws, [
      "ecs",
      "describe-task-definition",
      "--task-definition",
      current.tasks[workload]!,
    ]).taskDefinition;
    const container = (task?.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
      (item) => item.name === workload,
    );
    if (
      !container ||
      typeof container.image !== "string" ||
      !isPinnedWorkloadImage(config, workload, container.image)
    ) {
      throw new CliError(`cannot ${action} while untouched workload ${workload} lacks a trusted digest-pinned image`);
    }
  }
  return current;
}

function adoptMissingWorkloads(
  manifest: DeploymentManifest,
  snapshot: ReturnType<typeof serviceSnapshot>,
  workloads: string[],
): boolean {
  const missing = workloads.filter((workload) => !manifest.tasks[workload]);
  const active = missing.filter((workload) => snapshot.counts[workload] !== 0);
  if (active.length) {
    throw new CliError(
      `selected workload ${active.join(", ")} is missing from the current deployment manifest and must be scaled to zero before adoption`,
    );
  }
  if (!missing.length) return false;
  manifest.counts ??= {};
  for (const workload of missing) {
    manifest.tasks[workload] = snapshot.tasks[workload]!;
    manifest.counts[workload] = snapshot.counts[workload]!;
  }
  return true;
}

async function applyServiceTargets(
  config: QmConfig,
  targets: Record<string, string>,
  desiredCounts?: Record<string, number>,
  options: {
    waitForDrain?: boolean;
    waitForCompensationDrain?: boolean;
    timeoutMs?: number;
    webBeforePortal?: boolean;
  } = {},
): Promise<void> {
  const aws = requireAws(config);
  const workloads = Object.keys(targets);
  const states = describedServices(config, workloads);
  assertOwnedServices(config, states, workloads);
  const before = serviceSnapshotFromStates(states, workloads);
  const expectedCounts = Object.fromEntries(
    workloads.map((workload) => [workload, desiredCounts?.[workload] ?? before.counts[workload]!]),
  );
  const changed: string[] = [];
  try {
    for (const workload of options.webBeforePortal
      ? [...workloads].sort((a, b) => Number(b === "web-ui") - Number(a === "web-ui"))
      : workloads) {
      if (options.webBeforePortal && workload === "portal" && targets["web-ui"]) {
        await awaitServiceTargets(
          config,
          {
            "web-ui": {
              taskDefinition: targets["web-ui"]!,
              desiredCount: expectedCounts["web-ui"]!,
              waitForDrain: true,
            },
          },
          options.timeoutMs,
        );
      }
      const args = [
        "ecs",
        "update-service",
        "--cluster",
        aws.cluster,
        "--service",
        aws.services[workload]!.ecsService,
        "--task-definition",
        targets[workload]!,
        "--desired-count",
        String(expectedCounts[workload]),
      ];
      changed.push(workload);
      awsText(aws, args);
    }
    await awaitServiceTargets(
      config,
      Object.fromEntries(
        workloads.map((workload) => [
          workload,
          {
            taskDefinition: targets[workload]!,
            desiredCount: expectedCounts[workload]!,
            waitForDrain: options.waitForDrain,
          },
        ]),
      ),
      options.timeoutMs,
    );
  } catch (error) {
    const restoreFailures: string[] = [];
    for (const workload of [...changed].reverse()) {
      try {
        awsText(aws, [
          "ecs",
          "update-service",
          "--cluster",
          aws.cluster,
          "--service",
          aws.services[workload]!.ecsService,
          "--task-definition",
          before.tasks[workload]!,
          "--desired-count",
          String(before.counts[workload]),
        ]);
      } catch (restoreError) {
        restoreFailures.push(`${workload}: ${errMessage(restoreError)}`);
      }
    }
    if (changed.length && restoreFailures.length === 0) {
      try {
        await awaitServiceTargets(
          config,
          Object.fromEntries(
            changed.map((workload) => [
              workload,
              {
                taskDefinition: before.tasks[workload]!,
                desiredCount: before.counts[workload]!,
                waitForDrain: options.waitForCompensationDrain,
              },
            ]),
          ),
          options.timeoutMs,
        );
      } catch (restoreError) {
        restoreFailures.push(errMessage(restoreError));
      }
    }
    const detail = restoreFailures.length
      ? `; restoring the prior service set also failed (${restoreFailures.join("; ")})`
      : "";
    throw new CliError(`${errMessage(error)}${detail}`);
  }
}

function reportTaskChanges(
  config: QmConfig,
  services: string[],
  images: Record<string, string>,
  arns: Record<string, string>,
  restart: ReadonlySet<string> = new Set(),
): Array<{ service: string; task: EcsTaskDefinition; changed: boolean }> {
  const desired = services.map((service) => ({
    service,
    task: renderTaskDefinition(config, service, images[service]!, arns),
    live: liveTask(config, service),
  }));
  return desired.map((item) => {
    const changes = taskDefinitionChanges(item.task, item.live);
    step(
      `${item.service}: ${changes.length ? `${changes.length} task-definition change${changes.length === 1 ? "" : "s"}` : "no task-definition change"}`,
    );
    if (changes.length) note(JSON.stringify({ service: item.service, changes }, null, 2));
    if (restart.has(item.service)) step(`${item.service}: restart requested with the deployment`);
    return { service: item.service, task: item.task, changed: changes.length > 0 || restart.has(item.service) };
  });
}

function promoteStagedImage(config: QmConfig, service: string, image: string, label: string): void {
  const aws = requireAws(config);
  const repository = aws.services[service]!.ecrRepository;
  const digest = image.split("@")[1];
  if (!digest) throw new CliError(`staged image for ${service} is not digest-pinned`);
  const staged = awsJson<{ images?: Array<{ imageManifest?: string; imageManifestMediaType?: string }> }>(aws, [
    "ecr",
    "batch-get-image",
    "--repository-name",
    repository,
    "--image-ids",
    `imageDigest=${digest}`,
  ]).images?.[0];
  if (!staged?.imageManifest) throw new CliError(`ECR did not return the staged manifest for ${service}@${digest}`);
  try {
    awsText(aws, [
      "ecr",
      "put-image",
      "--repository-name",
      repository,
      "--image-tag",
      label,
      "--image-manifest",
      staged.imageManifest,
      ...(staged.imageManifestMediaType ? ["--image-manifest-media-type", staged.imageManifestMediaType] : []),
    ]);
  } catch (error) {
    if (!/ImageAlreadyExistsException/.test(errMessage(error))) throw error;
  }
}

function dbSnapshotRestoreHint(aws: AwsConfig, snapshot: string): string {
  return `restore: aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier ${snapshot} --db-instance-identifier ${rdsInstanceIdentifier(aws)}-restored --region ${aws.region}, then repoint the stack at the restored instance`;
}

function dbRestorePointHint(aws: AwsConfig, restorePoint: string): string {
  const database = rdsInstanceIdentifier(aws);
  return `restore: aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier ${database} --target-db-instance-identifier ${database}-restored --restore-time ${restorePoint} --region ${aws.region}, then repoint the stack at the restored instance; valid only while ${restorePoint} is inside the instance's automated-backup retention window`;
}

function manifestDbRestoreHint(aws: AwsConfig, manifest: DeploymentManifest): string | undefined {
  if (manifest.dbRestorePoint) return dbRestorePointHint(aws, manifest.dbRestorePoint);
  if (manifest.dbSnapshot) return dbSnapshotRestoreHint(aws, manifest.dbSnapshot);
  return undefined;
}

function assertPredeployDbRestorePoint(config: QmConfig): string {
  const aws = requireAws(config);
  const database = rdsInstanceIdentifier(aws);
  const instance = awsJson<{
    DBInstances?: Array<{ DBInstanceStatus?: string; BackupRetentionPeriod?: number; LatestRestorableTime?: string }>;
  }>(aws, ["rds", "describe-db-instances", "--db-instance-identifier", database]).DBInstances?.[0];
  if (instance?.DBInstanceStatus !== "available") {
    throw new CliError(
      `database ${database} is ${instance?.DBInstanceStatus ?? "missing"}; refusing to deploy without an available source for the pre-deploy restore point`,
    );
  }
  const retention = instance.BackupRetentionPeriod ?? 0;
  const minimumRetention = aws.dbRetentionMinDays ?? 1;
  if (retention < minimumRetention) {
    throw new CliError(
      `database ${database} keeps ${retention} day(s) of automated backups, below the required ${minimumRetention}; raise its backup retention (db_backup_retention_days in the reference module) or lower aws.dbRetentionMinDays before deploying`,
    );
  }
  const latestRestorable = Date.parse(instance.LatestRestorableTime ?? "");
  if (!Number.isFinite(latestRestorable)) {
    throw new CliError(
      `database ${database} reports no LatestRestorableTime; point-in-time recovery is not active, refusing to deploy without a restore point`,
    );
  }
  const lagMs = Date.now() - latestRestorable;
  const maxLagMs = envNum("QM_AWS_DB_MAX_RESTORE_LAG_MS", 10 * 60_000);
  if (lagMs > maxLagMs) {
    throw new CliError(
      `database ${database} is restorable only up to ${instance.LatestRestorableTime} (${Math.round(lagMs / 1000)}s ago, above the allowed ${Math.round(maxLagMs / 1000)}s); its continuous backup stream is behind, refusing to deploy without a fresh restore point`,
    );
  }
  const restorePoint = new Date().toISOString();
  ok(
    `pre-deploy database restore point: ${restorePoint} (continuous backups current to ${Math.round(lagMs / 1000)}s ago; ${dbRestorePointHint(aws, restorePoint)})`,
  );
  return restorePoint;
}

function confirmDbRestorePointCovered(config: QmConfig, restorePoint: string): void {
  const aws = requireAws(config);
  const database = rdsInstanceIdentifier(aws);
  let latestRestorable: string | undefined;
  try {
    latestRestorable = awsJson<{ DBInstances?: Array<{ LatestRestorableTime?: string }> }>(aws, [
      "rds",
      "describe-db-instances",
      "--db-instance-identifier",
      database,
    ]).DBInstances?.[0]?.LatestRestorableTime;
  } catch (error) {
    warn(`could not confirm the pre-deploy restore point ${restorePoint} is restorable yet: ${errMessage(error)}`);
    return;
  }
  const latest = Date.parse(latestRestorable ?? "");
  if (Number.isFinite(latest) && latest >= Date.parse(restorePoint)) {
    ok(`pre-deploy database restore point ${restorePoint} is covered by continuous backups`);
  } else if (Date.now() - Date.parse(restorePoint) <= envNum("QM_AWS_DB_MAX_RESTORE_LAG_MS", 10 * 60_000)) {
    note(
      `pre-deploy database restore point ${restorePoint} is not covered by continuous backups yet (database ${database} is restorable up to ${latestRestorable ?? "an unknown time"}); the stream catches up within minutes — leave the instance intact until it does`,
    );
  } else {
    warn(
      `pre-deploy database restore point ${restorePoint} is still not restorable: database ${database} is restorable only up to ${latestRestorable ?? "an unknown time"}; if the instance is lost before its backup stream passes the restore point, that point is unrecoverable — leave the instance intact until this catches up`,
    );
  }
}

export async function awsUp(config: QmConfig, _configDir: string, opts: AwsUpOpts = {}): Promise<void> {
  const topology = awsTopology(config, _configDir);
  const { aws } = topology;
  if (new URL(config.publicUrl).protocol !== "https:") {
    throw new CliError(
      "AWS deploy requires an HTTPS publicUrl; configure an ACM certificate, update publicUrl, and rerender/apply Terraform before running `qm up`",
    );
  }
  const plugins = new Map(topology.plugins.map((plugin) => [plugin.name, plugin]));
  const services = opts.only ? [...new Set(opts.only.map(serviceHost))] : topology.workloads;
  const buildConcurrency = opts.buildConcurrency ?? 1;
  if (!Number.isSafeInteger(buildConcurrency) || buildConcurrency < 1)
    throw new CliError("--build-concurrency requires a positive integer");
  if (opts.buildConcurrency !== undefined && !opts.buildOnly)
    throw new CliError("--build-concurrency requires --build-only");
  if (
    buildConcurrency > 1 &&
    new Set(services.map((service) => aws.services[service]?.ecrRepository)).size !== services.length
  )
    throw new CliError("--build-concurrency requires distinct ECR repositories for selected workloads");
  const restart = new Set((opts.restart ?? []).map(serviceHost));
  if (restart.size && opts.buildOnly) throw new CliError("--restart cannot be used with --build-only");
  for (const service of restart) {
    if (!services.includes(service)) throw new CliError(`--restart workload ${service} is not selected for deployment`);
  }
  for (const service of services) workloadArchitecture(config, service);
  if (opts.buildOnly && opts.candidate) throw new CliError("--build-only and --candidate are mutually exclusive");
  if (opts.candidate && opts.buildFrom) throw new CliError("--candidate and --build-from are mutually exclusive");
  if (opts.inactive && (opts.dryRun || !opts.candidate)) {
    throw new CliError("--inactive is only valid for an exact candidate deployment");
  }
  if (opts.buildOnly && !opts.imageLabel) throw new CliError("--build-only requires --image-label <label>");
  if (opts.buildOnly && !opts.candidateOut) throw new CliError("--build-only requires --candidate-out <path>");
  if (opts.imageLabel && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(opts.imageLabel)) {
    throw new CliError("--image-label must be a valid ECR tag");
  }
  if (opts.buildFrom) resolveBuildRepoRoot(opts.buildFromPath, services.filter(isServiceName));
  if (opts.buildOnly) {
    assertAwsCallerAccount(aws);
    header(`qm ${opts.dryRun ? "plan" : "build"} — ${config.orgId} (aws candidate ${opts.imageLabel})`);
    if (opts.dryRun) {
      for (const service of services) step(`${service}: build immutable candidate image`);
      note(`Plan only. Candidate manifest would be written to ${opts.candidateOut}.`);
      return;
    }
    dockerLogin(aws);
    const images: Record<string, string> = {};
    const imageProvenance: Record<string, DeploymentImageProvenance> = {};
    for (const service of services) {
      imageProvenance[service] = workloadImageProvenance(config, service, plugins.get(service), opts);
    }
    const controller = new AbortController();
    const cancelBuilds = () => controller.abort();
    process.on("SIGINT", cancelBuilds);
    process.on("SIGTERM", cancelBuilds);
    try {
      for (let offset = 0; offset < services.length; offset += buildConcurrency) {
        await settleAll(
          services.slice(offset, offset + buildConcurrency).map(async (service) => {
            images[service] = await publishWorkloadImage(
              config,
              service,
              plugins.get(service),
              opts.imageLabel!,
              opts,
              controller.signal,
            );
          }),
        );
      }
    } finally {
      process.off("SIGINT", cancelBuilds);
      process.off("SIGTERM", cancelBuilds);
    }
    const release: AwsReleaseCandidate = {
      contract: 1,
      accountId: aws.accountId,
      region: aws.region,
      label: opts.imageLabel!,
      images,
      imageProvenance,
    };
    writeFileSync(opts.candidateOut!, `${JSON.stringify(release, null, 2)}\n`, { mode: 0o600 });
    ok(`AWS release candidate written to ${opts.candidateOut}`);
    return;
  }
  const candidate = opts.candidate ? releaseCandidate(config, opts.candidate) : undefined;
  for (const service of services) {
    if (candidate && (!candidate.images[service] || !candidate.imageProvenance[service])) {
      throw new CliError(`AWS release candidate ${opts.candidate} does not contain ${service}`);
    }
  }
  if (opts.imageLabel && opts.imageLabel !== aws.imageLabel) {
    throw new CliError(
      `--image-label ${opts.imageLabel} differs from durable aws.imageLabel ${aws.imageLabel}; update and commit the deployment directory first`,
    );
  }
  const label = aws.imageLabel;
  if (!label) throw new CliError("aws.imageLabel is required");
  if (!opts.dryRun && !opts.yes) throw new CliError("AWS deploy requires --yes after reviewing `qm plan`");
  assertAwsCallerAccount(aws);
  assertAwsPublicFrontDoor(config);
  if (!opts.dryRun && !opts.inactive) await assertAwsPublicNetwork(config);
  assertAwsPublicApiUrl(config);
  assertAwsDeployImage(config);
  header(`qm ${opts.dryRun ? "plan" : "up"} — ${config.orgId} (aws)`);
  const allServices = topology.workloads;
  assertOwnedServices(config, describedServices(config, allServices), allServices);
  const arns = secretArns(config);
  if (opts.dryRun) {
    step(
      aws.predeployDbSnapshot === false
        ? "pre-deploy database restore point: disabled (aws.predeployDbSnapshot)"
        : `pre-deploy database restore point: verify ${rdsInstanceIdentifier(aws)} point-in-time recovery is current before the first mutation`,
    );
    const before = serviceSnapshot(config, allServices);
    const selected = new Set(services);
    if (allServices.some((service) => !selected.has(service))) {
      const baseline = trustedDeploymentBaseline(
        config,
        before,
        allServices.filter((name) => !selected.has(name)),
      );
      adoptMissingWorkloads(baseline, before, services);
    }
    const images: Record<string, string> = {};
    for (const service of services) {
      if (candidate) {
        images[service] = candidate.images[service]!;
        step(`${service}: immutable candidate ${candidate.label}`);
        continue;
      }
      const spec = aws.services[service]!;
      const sourceBuild = (opts.buildFrom && isServiceName(service)) || plugins.get(service)?.kind === "source";
      if (sourceBuild) {
        images[service] = `${ecrHost(aws)}/${spec.ecrRepository}@sha256:${"0".repeat(64)}`;
        step(`${service}: source build planned; image digest is unresolved until build`);
        continue;
      }
      images[service] = plannedWorkloadImage(config, service, plugins.get(service));
    }
    reportTaskChanges(config, services, images, arns, restart);
    for (const service of services) {
      step(`${service}: desired count ${before.counts[service] ?? 0} → ${workloadDesiredCount(config, service)}`);
    }
    if (opts.sandboxDir && existsSync(opts.sandboxDir) && (!opts.only || opts.only.includes("core"))) {
      const hash = createHash("sha256").update(deploymentLayerBody(opts.sandboxDir)).digest("hex");
      try {
        const current = currentDeploymentManifest(aws);
        step(`deployment layer: ${current?.layer?.sha256 === hash ? "unchanged" : "changed"} (${hash.slice(0, 12)})`);
      } catch {
        step(`deployment layer: desired ${hash.slice(0, 12)} (live state unavailable)`);
      }
    } else {
      step("deployment layer: preserved (no sandbox directory selected for core)");
    }
    note(
      `Plan only. Re-run \`qm up${opts.candidate ? ` --candidate ${opts.candidate}` : ""}${restart.size ? ` --restart ${[...restart].join(",")}` : ""} --yes\` to deploy.`,
    );
    return;
  }
  const lease = acquireLease(aws);
  const releaseId = randomUUID();
  const stagingLabel = "qm-staging";
  const staged = new Set<string>();
  const promotedServices = new Set<string>();
  let before: ReturnType<typeof serviceSnapshot> | undefined;
  let applied = false;
  let current: DeploymentManifest | undefined;
  let recorded: DeploymentManifest | undefined;
  let releaseSucceeded = false;
  let previousLayerBody: string | undefined;
  let previousLayerBootstrapped = false;
  let desiredLayerBody: string | undefined;
  let desiredLayer: DeploymentManifest["layer"];
  let layerChanged = false;
  let layerAttempted = false;
  let dbRestorePoint: string | undefined;
  let migratedCandidate = false;
  try {
    assertAwsDeployImage(config);
    before = serviceSnapshot(config, allServices);
    current = currentDeploymentManifest(aws);
    const selected = new Set(services);
    if (allServices.some((service) => !selected.has(service))) {
      current = trustedDeploymentBaseline(
        config,
        before,
        allServices.filter((name) => !selected.has(name)),
      );
      if (adoptMissingWorkloads(current, before, services)) manifestTransaction(aws, current, current.id);
    }
    if (aws.predeployDbSnapshot === false)
      note("pre-deploy database restore point: disabled (aws.predeployDbSnapshot)");
    else dbRestorePoint = assertPredeployDbRestorePoint(config);
    if (candidate?.images.core && services.includes("core")) {
      await runAwsCandidateMigration(config, candidate.images.core, candidate.label);
      migratedCandidate = true;
    }
    if (current?.layer) {
      desiredLayer = current.layer;
    } else {
      if (current || before.counts.core !== 0) {
        const previousState = await currentDeploymentLayerState({
          config,
          transport: awsDeploymentLayerTransport,
          configDir: _configDir,
          ...(opts.envFile ? { envFile: opts.envFile } : {}),
        });
        previousLayerBody = previousState.body;
        previousLayerBootstrapped = previousState.bootstrapped;
      } else {
        previousLayerBody = JSON.stringify({ contract: 1, tools: [], skills: [] });
        previousLayerBootstrapped = true;
      }
      if (!previousLayerBootstrapped) {
        desiredLayer = putDeploymentLayerArtifact(config, previousLayerBody);
        if (current) {
          current.layer = desiredLayer;
          manifestTransaction(aws, current, current.id);
        }
      }
    }
    if (opts.sandboxDir && existsSync(opts.sandboxDir) && (!opts.only || opts.only.includes("core"))) {
      previousLayerBody ??= getDeploymentLayerArtifact(config, desiredLayer);
      desiredLayerBody = deploymentLayerBody(opts.sandboxDir);
      desiredLayer = putDeploymentLayerArtifact(config, desiredLayerBody);
      layerChanged = desiredLayer.sha256 !== current?.layer?.sha256;
      if (!layerChanged) {
        const state = await currentDeploymentLayerState({
          config,
          transport: awsDeploymentLayerTransport,
          configDir: _configDir,
          ...(opts.envFile ? { envFile: opts.envFile } : {}),
        });
        if (
          state.status === "applied" &&
          state.contentHash === desiredLayer.sha256 &&
          state.runtimeContentHash === desiredLayer.sha256
        ) {
          desiredLayerBody = undefined;
        }
      }
    }
    if (!candidate) dockerLogin(aws);
    const images: Record<string, string> = {};
    const selectedImageProvenance: Record<string, DeploymentImageProvenance> = {};
    for (const service of services) {
      if (candidate) {
        selectedImageProvenance[service] = candidate.imageProvenance[service]!;
        images[service] = candidate.images[service]!;
      } else {
        staged.add(service);
        selectedImageProvenance[service] = workloadImageProvenance(config, service, plugins.get(service), opts);
        images[service] = await publishWorkloadImage(config, service, plugins.get(service), stagingLabel, opts);
      }
    }
    const desired = reportTaskChanges(config, services, images, arns, restart);
    const targets: Record<string, string> = {};
    for (const item of desired) {
      if (!item.changed) {
        targets[item.service] = before.tasks[item.service]!;
        continue;
      }
      const file = join(mkdtempSync(join(tmpdir(), "qm-task-")), `${item.service}.json`);
      writeFileSync(file, JSON.stringify(item.task));
      const taskDefinition = registerTaskDefinition(config, file);
      targets[item.service] = taskDefinition;
    }
    const rolloutTargets = Object.fromEntries(
      services
        .filter(
          (service) =>
            desired.find((item) => item.service === service)!.changed ||
            before!.counts[service] !== workloadDesiredCount(config, service),
        )
        .map((service) => [service, targets[service]!]),
    );
    if (Object.keys(rolloutTargets).length) {
      await applyServiceTargets(
        config,
        rolloutTargets,
        Object.fromEntries(
          Object.keys(rolloutTargets).map((service) => [service, workloadDesiredCount(config, service)]),
        ),
        { webBeforePortal: true },
      );
      applied = true;
    }
    await awaitServiceTargets(
      config,
      Object.fromEntries(
        services.map((service) => [
          service,
          { taskDefinition: targets[service]!, desiredCount: workloadDesiredCount(config, service) },
        ]),
      ),
    );
    if (desiredLayerBody) {
      layerAttempted = true;
      await syncAwsLayerAfterRoll(
        {
          config,
          transport: awsDeploymentLayerTransport,
          configDir: _configDir,
          ...(opts.envFile ? { envFile: opts.envFile } : {}),
        },
        desiredLayerBody,
        desiredLayer!,
      );
    }
    const releaseTasks = { ...before.tasks, ...targets };
    const releaseCounts = Object.fromEntries(
      allServices.map((service) => [service, workloadDesiredCount(config, service)]),
    );
    const releaseImageProvenance = { ...current?.imageProvenance, ...selectedImageProvenance };
    const sameTasks = current && allServices.every((service) => current!.tasks[service] === releaseTasks[service]);
    const sameCounts = current && canonicalJson(current.counts ?? {}) === canonicalJson(releaseCounts);
    const sameImageProvenance =
      current && canonicalJson(current.imageProvenance ?? {}) === canonicalJson(releaseImageProvenance);
    releaseSucceeded = true;
    if (
      !current ||
      !sameTasks ||
      !sameCounts ||
      !sameImageProvenance ||
      current.imageLabel !== label ||
      layerChanged ||
      migratedCandidate
    ) {
      recorded = recordDeploymentManifest(aws, releaseTasks, {
        id: releaseId,
        counts: releaseCounts,
        imageLabel: label,
        ...(dbRestorePoint ? { dbRestorePoint } : {}),
        ...(desiredLayer ? { layer: desiredLayer } : {}),
        imageProvenance: releaseImageProvenance,
      });
    }
    if (recorded && dbRestorePoint) confirmDbRestorePointCovered(config, dbRestorePoint);
    for (const service of services) {
      try {
        promoteStagedImage(config, service, images[service]!, label);
        promotedServices.add(service);
      } catch (error) {
        warn(
          `AWS deployment succeeded, but could not promote ${service}:${label}: ${errMessage(error)}; preserving staging tag ${stagingLabel} so the deployed digest remains pullable; rerun \`qm up --yes\` to retry promotion`,
        );
      }
    }
  } catch (error) {
    if (releaseSucceeded) throw error;
    const compensationFailures: string[] = [];
    if (layerAttempted && previousLayerBody && !previousLayerBootstrapped) {
      try {
        await syncAwsLayerAfterRoll(
          {
            config,
            transport: awsDeploymentLayerTransport,
            configDir: _configDir,
            ...(opts.envFile ? { envFile: opts.envFile } : {}),
          },
          previousLayerBody,
          createHash("sha256").update(previousLayerBody).digest("hex"),
        );
      } catch (restoreError) {
        compensationFailures.push(`restoring the pre-deploy deployment layer: ${errMessage(restoreError)}`);
      }
    } else if (layerAttempted && previousLayerBootstrapped) {
      warn(
        `the pre-deploy layer snapshot was synthesized (the core had no durable layer record) — leaving the core's layer as the failed sync left it rather than durably installing the empty bundle`,
      );
    }
    if (applied && before) {
      try {
        await applyServiceTargets(config, before.tasks, before.counts);
      } catch (restoreError) {
        compensationFailures.push(`restoring the pre-deploy manifest: ${errMessage(restoreError)}`);
      }
    }
    throwAfterCompensation(error, compensationFailures);
  } finally {
    for (const service of staged) {
      if (releaseSucceeded && !promotedServices.has(service)) continue;
      try {
        awsText(aws, [
          "ecr",
          "batch-delete-image",
          "--repository-name",
          aws.services[service]!.ecrRepository,
          "--image-ids",
          `imageTag=${stagingLabel}`,
        ]);
      } catch (error) {
        if (!/ImageNotFoundException/.test(errMessage(error)))
          warn(`could not clean staging image ${service}:${stagingLabel}: ${errMessage(error)}`);
      }
    }
    releaseLease(aws, lease);
  }
  ok(`AWS services stable on ${label} (deployment ${recorded?.id ?? current?.id})`);
}

export function awsStatus(config: QmConfig, configDir = process.cwd()): void {
  const { aws, workloads } = awsTopology(config, configDir);
  assertAwsCallerAccount(aws);
  const result = describedServices(config, workloads);
  header(`qm status — ${config.orgId} (aws)`);
  for (const workload of workloads) {
    const service = result.get(workload)!;
    note(`${service.serviceName}: ${service.runningCount}/${service.desiredCount} running · ${service.taskDefinition}`);
  }
  if (config.services.includes("slack")) note("slack: virtual service running in the core task");
}

export function awsLogs(
  config: QmConfig,
  service: string | undefined,
  opts: LogOpts,
  configDir = process.cwd(),
): void | Promise<void> {
  const { aws, workloads } = awsTopology(config, configDir);
  assertAwsCallerAccount(aws);
  if (opts.tail !== undefined)
    note(`(--tail is a docker-only line count; aws logs tail has none, so it's ignored on the aws target)`);
  const logArgs = (name: string): string[] => {
    const spec = aws.services[name];
    if (!spec) throw new CliError(`unknown AWS workload ${name}`);
    return awsArgs(aws, [
      "logs",
      "tail",
      spec.logGroup ?? `/ecs/${spec.ecsService}`,
      ...(opts.follow ? ["--follow"] : []),
    ]);
  };
  if (service) {
    const resolved = serviceHost(service);
    if (resolved !== service) note(`${service} runs in ${resolved}; showing ${resolved} logs`);
    runInherit(process.env.AWS_BIN ?? "aws", logArgs(resolved));
    return;
  }
  return streamLabeled(
    workloads.map((name) => ({ label: name, command: process.env.AWS_BIN ?? "aws", args: logArgs(name) })),
    (label, line) => note(`${dim(label)} | ${line}`),
  );
}

export async function awsDown(config: QmConfig, configDir = process.cwd()): Promise<void> {
  const { aws, workloads } = awsTopology(config, configDir);
  assertAwsCallerAccount(aws);
  assertOwnedServices(config, describedServices(config, workloads), workloads);
  const lease = acquireLease(aws);
  try {
    const before = serviceSnapshot(config, workloads);
    await applyServiceTargets(config, before.tasks, Object.fromEntries(workloads.map((workload) => [workload, 0])));
  } finally {
    releaseLease(aws, lease);
  }
  ok(
    "AWS services set to zero desired tasks; protected tasks finish in-flight turns before stopping. Infrastructure and data were retained.",
  );
}

function firstRolledBackDbRestore(
  aws: AwsConfig,
  current: DeploymentManifest,
  targetId: string,
): { kind: "restore point" | "snapshot"; hint: string } | undefined {
  const seen = new Set<string>();
  let oldest: { kind: "restore point" | "snapshot"; hint: string } | undefined;
  let manifest: DeploymentManifest | undefined = current;
  while (manifest && !seen.has(manifest.id)) {
    if (manifest.id === targetId) return oldest;
    if (manifest.dbRestorePoint) {
      oldest = { kind: "restore point", hint: `${manifest.dbRestorePoint} (${manifestDbRestoreHint(aws, manifest)})` };
    } else if (manifest.dbSnapshot) {
      oldest = { kind: "snapshot", hint: `${manifest.dbSnapshot} (${manifestDbRestoreHint(aws, manifest)})` };
    }
    seen.add(manifest.id);
    if (!manifest.previous) return undefined;
    try {
      manifest = deploymentManifest(aws, manifest.previous);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function awsRollback(
  config: QmConfig,
  to?: string,
  layerOpts?: { configDir: string; envFile?: string },
): Promise<void> {
  const { aws, workloads: services } = awsTopology(config, layerOpts?.configDir ?? process.cwd());
  assertAwsCallerAccount(aws);
  const lease = acquireLease(aws);
  let before: ReturnType<typeof serviceSnapshot> | undefined;
  let applied = false;
  let currentLayerBody: string | undefined;
  let layerAttempted = false;
  let rolledBack = false;
  try {
    before = serviceSnapshot(config, services);
    const currentManifest = currentDeploymentManifest(aws);
    let targetManifest: DeploymentManifest | undefined;
    if (!to) {
      if (!currentManifest?.previous) throw new CliError("no previous recorded AWS deployment to roll back to");
      targetManifest = deploymentManifest(aws, currentManifest.previous);
    } else {
      targetManifest = deploymentManifestForTarget(aws, to);
    }
    const missing = services.filter((service) => !targetManifest.tasks[service]);
    if (missing.length)
      throw new CliError(`target AWS deployment manifest is missing workloads: ${missing.join(", ")}`);
    let targetLayerBody: string | undefined;
    let layerNeedsSync = false;
    if (layerOpts) {
      targetLayerBody = getDeploymentLayerArtifact(config, targetManifest.layer);
      if (currentManifest?.layer) currentLayerBody = getDeploymentLayerArtifact(config, currentManifest.layer);
      else if (currentManifest)
        throw new CliError(`current AWS deployment manifest ${currentManifest.id} has no restorable deployment layer`);
      layerNeedsSync = currentManifest?.layer?.sha256 !== targetManifest.layer!.sha256;
    }
    const targets = Object.fromEntries(services.map((service) => [service, targetManifest!.tasks[service]!]));
    const targetCounts = Object.fromEntries(
      services.map((service) => [service, targetManifest.counts?.[service] ?? before!.counts[service]!]),
    );
    const changedTargets = Object.fromEntries(
      services
        .filter(
          (service) => before!.tasks[service] !== targets[service] || before!.counts[service] !== targetCounts[service],
        )
        .map((service) => [service, targets[service]!]),
    );
    if (Object.keys(changedTargets).length) {
      await applyServiceTargets(
        config,
        changedTargets,
        Object.fromEntries(Object.keys(changedTargets).map((service) => [service, targetCounts[service]!])),
      );
      applied = true;
    }
    await awaitServiceTargets(
      config,
      Object.fromEntries(
        services.map((service) => [
          service,
          { taskDefinition: targets[service]!, desiredCount: targetCounts[service]! },
        ]),
      ),
    );
    if (targetLayerBody && layerOpts && layerNeedsSync) {
      if (targetCounts.core === 0) {
        note(
          "deployment layer sync deferred: core is scaled to zero, so `check --live` will flag the layer until the next `qm up` applies it",
        );
      } else {
        layerAttempted = true;
        await syncAwsLayerAfterRoll(
          {
            config,
            transport: awsDeploymentLayerTransport,
            configDir: layerOpts.configDir,
            ...(layerOpts.envFile ? { envFile: layerOpts.envFile } : {}),
          },
          targetLayerBody,
          targetManifest.layer!,
        );
      }
    }
    rolledBack = true;
    if (currentManifest?.id !== targetManifest.id) {
      manifestTransaction(aws, undefined, targetManifest.id);
      const dbRestore = currentManifest && firstRolledBackDbRestore(aws, currentManifest, targetManifest.id);
      if (dbRestore) {
        note(
          `rollback restores code and configuration, not data; the database ${dbRestore.kind} taken before the first rolled-back deployment is ${dbRestore.hint}`,
        );
      }
    }
  } catch (error) {
    if (rolledBack) throw error;
    const compensationFailures: string[] = [];
    if (layerAttempted && currentLayerBody && layerOpts) {
      try {
        await syncAwsLayerAfterRoll(
          {
            config,
            transport: awsDeploymentLayerTransport,
            configDir: layerOpts.configDir,
            ...(layerOpts.envFile ? { envFile: layerOpts.envFile } : {}),
          },
          currentLayerBody,
          createHash("sha256").update(currentLayerBody).digest("hex"),
        );
      } catch (restoreError) {
        compensationFailures.push(`restoring the pre-rollback deployment layer: ${errMessage(restoreError)}`);
      }
    }
    if (applied && before) {
      try {
        await applyServiceTargets(config, before.tasks, before.counts);
      } catch (restoreError) {
        compensationFailures.push(`restoring the pre-rollback manifest: ${errMessage(restoreError)}`);
      }
    }
    throwAfterCompensation(error, compensationFailures);
  } finally {
    releaseLease(aws, lease);
  }
  ok(`rolled back ${config.orgId}`);
}

export function taskDefinitionForBackgroundWork(
  task: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  const containers = structuredClone(task.containerDefinitions) as Array<Record<string, unknown>> | undefined;
  const core = containers?.find((container) => container.name === "core");
  if (!core) throw new CliError("core task definition has no core container");
  const secrets = core.secrets as Array<{ name: string }> | undefined;
  if (secrets?.some((entry) => entry.name === "BACKGROUND_WORK_ENABLED")) {
    throw new CliError("BACKGROUND_WORK_ENABLED cannot be changed while supplied as a secret");
  }
  const environment = (core.environment ?? []) as Array<{ name: string; value: string }>;
  core.environment = [
    ...environment.filter((entry) => entry.name !== "BACKGROUND_WORK_ENABLED"),
    { name: "BACKGROUND_WORK_ENABLED", value: enabled ? "1" : "0" },
  ];
  const fields = [
    "family",
    "taskRoleArn",
    "executionRoleArn",
    "networkMode",
    "volumes",
    "placementConstraints",
    "requiresCompatibilities",
    "cpu",
    "memory",
    "pidMode",
    "ipcMode",
    "proxyConfiguration",
    "inferenceAccelerators",
    "ephemeralStorage",
    "runtimePlatform",
    "enableFaultInjection",
  ];
  return {
    ...Object.fromEntries(fields.flatMap((field) => (task[field] == null ? [] : [[field, task[field]]]))),
    containerDefinitions: containers,
  };
}

export async function awsSetBackgroundWork(
  config: QmConfig,
  configDir: string,
  enabled: boolean,
  candidatePath?: string,
): Promise<void> {
  const { aws, workloads } = awsTopology(config, configDir);
  if (!workloads.includes("core")) throw new CliError("background work requires the core workload");
  const candidate = candidatePath ? releaseCandidate(config, candidatePath) : undefined;
  assertAwsCallerAccount(aws);
  await withAwsLease(aws, async () => {
    const current = currentDeploymentManifest(aws);
    if (!current) throw new CliError("background work requires a recorded deployment");
    const states = describedServices(config, workloads);
    assertOwnedServices(config, states, workloads);
    const before = serviceSnapshotFromStates(states, workloads);
    for (const workload of workloads) {
      if (
        current.tasks[workload] !== before.tasks[workload] ||
        current.counts?.[workload] !== before.counts[workload]
      ) {
        throw new CliError(`cannot change background work while ${workload} differs from the deployment manifest`);
      }
    }
    if (!before.counts.core) throw new CliError("cannot change background work while core is scaled down");
    let coreTask: Record<string, unknown> | undefined;
    for (const workload of candidate ? workloads : ["core"]) {
      const task = awsJson<{ taskDefinition?: Record<string, unknown> }>(aws, [
        "ecs",
        "describe-task-definition",
        "--task-definition",
        before.tasks[workload]!,
      ]).taskDefinition;
      const container = (task?.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
        (item) => item.name === workload,
      );
      if (!task || typeof container?.image !== "string" || !isPinnedWorkloadImage(config, workload, container.image)) {
        throw new CliError(`${workload} does not have a trusted digest-pinned image`);
      }
      if (
        candidate &&
        (container.image !== candidate.images[workload] ||
          !candidate.imageProvenance[workload] ||
          canonicalJson(candidate.imageProvenance[workload]) !== canonicalJson(current.imageProvenance?.[workload]))
      ) {
        throw new CliError(`${workload} does not match the expected release candidate`);
      }
      if (workload === "core") coreTask = task;
    }
    const desired = taskDefinitionForBackgroundWork(coreTask!, enabled);
    const core = (coreTask!.containerDefinitions as Array<Record<string, unknown>>).find(
      (item) => item.name === "core",
    )!;
    const environment = (core.environment ?? []) as Array<{ name: string; value: string }>;
    const currentFlag = environment.find((entry) => entry.name === "BACKGROUND_WORK_ENABLED")?.value;
    const timeoutMs = envNum("QM_AWS_ROLLOUT_DEADLINE_MS", 30 * 60_000);
    if (currentFlag === (enabled ? "1" : "0")) {
      await awaitServiceTargets(
        config,
        {
          core: { taskDefinition: before.tasks.core!, desiredCount: before.counts.core, waitForDrain: !enabled },
        },
        timeoutMs,
      );
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "qm-background-work-"));
    try {
      const file = join(dir, "core.json");
      writeFileSync(file, JSON.stringify(desired));
      const target = registerTaskDefinition(config, file);
      await applyServiceTargets(
        config,
        { core: target },
        { core: before.counts.core },
        { waitForDrain: !enabled, waitForCompensationDrain: true, timeoutMs },
      );
      try {
        recordDeploymentManifest(
          aws,
          { ...before.tasks, core: target },
          {
            counts: current.counts,
            imageLabel: current.imageLabel,
            dbRestorePoint: current.dbRestorePoint,
            layer: current.layer,
            imageProvenance: current.imageProvenance,
          },
        );
      } catch (error) {
        const failures: string[] = [];
        try {
          await applyServiceTargets(
            config,
            { core: before.tasks.core! },
            { core: before.counts.core },
            { waitForDrain: true, waitForCompensationDrain: true, timeoutMs },
          );
          manifestTransaction(aws, current, current.id);
        } catch (restoreError) {
          failures.push(`restoring background work: ${errMessage(restoreError)}`);
        }
        throwAfterCompensation(error, failures);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  ok(`background work ${enabled ? "enabled" : "disabled"}`);
}

function envValues(configDir: string, path: string | undefined): Map<string, string> {
  const file = resolve(path ?? join(configDir, ".env"));
  if (!existsSync(file)) {
    if (path) throw new CliError(`secret source not found: ${file}`);
    return new Map();
  }
  return readEnvFile(file);
}

export async function awsSecretsPush(config: QmConfig, configDir: string, envFile?: string): Promise<void> {
  validatedSecrets(config);
  const { aws, workloads } = awsTopology(config, configDir);
  assertAwsCallerAccount(aws);
  const values = envValues(configDir, envFile);
  const staged: Array<{ name: string; id: string; dir: string; file: string }> = [];
  try {
    for (const secret of computedSecrets(config).filter((item) => item.managedBy === "operator")) {
      const supplied = deploymentSecretValue(secret.name, values.get(secret.name));
      if (!secret.required && !supplied) {
        step(`${secret.name}: optional, not supplied`);
        continue;
      }
      const value = supplied ?? (await promptHidden(secret.name));
      if (isInvalidSecret(secret.name, value)) {
        throw new CliError(
          `${secret.name} must have a non-empty, non-placeholder value; signing keys must be at least 32 characters`,
        );
      }
      const dir = mkdtempSync(join(tmpdir(), "qm-secret-"));
      const file = join(dir, "value");
      writeFileSync(file, value, { mode: 0o600 });
      staged.push({ name: secret.name, id: `${aws.secretsPrefix}${secret.name}`, dir, file });
    }
    await withAwsLease(aws, async () => {
      const baseline = currentDeploymentManifest(aws);
      const states = describedServices(config, workloads);
      assertOwnedServices(config, states, workloads);
      const before = baseline ? serviceSnapshotFromStates(states, workloads) : undefined;
      if (baseline) {
        const drifted = workloads.filter(
          (workload) => !baseline.tasks[workload] || before!.tasks[workload] !== baseline.tasks[workload],
        );
        if (drifted.length)
          throw new CliError(
            `cannot rotate secrets while workloads differ from the current deployment manifest: ${drifted.join(", ")}`,
          );
      } else {
        const active = workloads.filter((workload) => {
          const state = states.get(workload)!;
          return state.desiredCount !== 0 || state.runningCount !== 0;
        });
        if (active.length) {
          throw new CliError(
            `cannot defer secret activation without a current deployment manifest while workloads are active: ${active.join(", ")}`,
          );
        }
      }
      const uploaded = Object.fromEntries(staged.map((secret) => [secret.name, secret.id]));
      const affected = workloads.filter((workload) =>
        workloadSecrets(config, workload, uploaded).some((secret) => uploaded[secret.name]),
      );
      for (const secret of staged) {
        try {
          awsText(aws, [
            "secretsmanager",
            "put-secret-value",
            "--secret-id",
            secret.id,
            "--secret-string",
            `file://${secret.file}`,
          ]);
        } catch (error) {
          if (/ResourceNotFoundException/.test(errMessage(error))) {
            throw new CliError(
              `AWS secret container ${secret.id} is missing; apply the rendered Terraform before pushing secrets`,
            );
          }
          throw error;
        }
        step(`${secret.name}: uploaded`);
      }
      if (!baseline || !before) {
        if (affected.length) step("secret activation deferred to the first complete AWS deployment");
        return;
      }
      for (const [component, host, marker, expected] of [
        ["admin", "web-ui", "ADMIN_ENABLED", "1"],
        ["auth", "portal", "AUTH_EMBEDDED", "1"],
        ["admin", "portal", "ADMIN_UPSTREAM", serviceEnvironment(config, "portal").ADMIN_UPSTREAM],
      ] as const) {
        if (!config.services.includes(component) || !workloads.includes(host)) continue;
        const task = awsJson<{ taskDefinition?: Record<string, unknown> }>(aws, [
          "ecs",
          "describe-task-definition",
          "--task-definition",
          before.tasks[host]!,
        ]).taskDefinition;
        const container = (task?.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
          (item) => item.name === host,
        );
        const environment = (container?.environment ?? []) as Array<{ name: string; value: string }>;
        if (!environment.some((entry) => entry.name === marker && entry.value === expected)) {
          step("secret activation deferred until combined web-ui and portal images are deployed with qm up");
          return;
        }
      }
      const arns = secretArns(config);
      const targets = { ...before.tasks };
      const changed: Record<string, string> = {};
      for (const workload of affected) {
        const live =
          awsJson<{ taskDefinition?: Record<string, unknown> }>(aws, [
            "ecs",
            "describe-task-definition",
            "--task-definition",
            before.tasks[workload]!,
          ]).taskDefinition ?? null;
        const container = (live?.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
          (item) => item.name === workload,
        );
        if (
          !container ||
          typeof container.image !== "string" ||
          !isPinnedWorkloadImage(config, workload, container.image)
        ) {
          throw new CliError(`cannot rotate secrets while ${workload} lacks a trusted digest-pinned image`);
        }
        const desired = renderTaskDefinition(config, workload, container.image, arns);
        if (!taskDefinitionChanges(desired, live).length) continue;
        const dir = mkdtempSync(join(tmpdir(), "qm-task-"));
        try {
          const file = join(dir, `${workload}.json`);
          writeFileSync(file, JSON.stringify(desired));
          targets[workload] = registerTaskDefinition(config, file);
          changed[workload] = targets[workload]!;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      let changedApplied = false;
      let rotated = false;
      try {
        if (Object.keys(changed).length) {
          await applyServiceTargets(
            config,
            changed,
            Object.fromEntries(Object.keys(changed).map((workload) => [workload, before.counts[workload]!])),
          );
          changedApplied = true;
        }
        const unchanged = affected.filter((workload) => !changed[workload]);
        const forcedDeployments: Record<string, string> = {};
        for (const workload of unchanged) {
          const service = awsJson<{ service?: { deployments?: EcsDeploymentState[] } }>(aws, [
            "ecs",
            "update-service",
            "--cluster",
            aws.cluster,
            "--service",
            aws.services[workload]!.ecsService,
            "--force-new-deployment",
          ]).service;
          const primary = (service?.deployments ?? []).filter((deployment) => deployment.status === "PRIMARY");
          if (primary.length !== 1 || !primary[0]?.id)
            throw new CliError(`AWS did not identify the replacement deployment for ${workload}`);
          forcedDeployments[workload] = primary[0].id;
        }
        if (unchanged.length) {
          await awaitServiceTargets(
            config,
            Object.fromEntries(
              unchanged.map((workload) => [
                workload,
                {
                  taskDefinition: before.tasks[workload]!,
                  desiredCount: before.counts[workload]!,
                  deploymentId: forcedDeployments[workload]!,
                },
              ]),
            ),
          );
        }
        rotated = true;
        if (Object.keys(changed).length) {
          recordDeploymentManifest(aws, targets, {
            ...(baseline.counts ? { counts: baseline.counts } : {}),
            imageLabel: baseline.imageLabel ?? aws.imageLabel,
            ...(baseline.layer ? { layer: baseline.layer } : {}),
            ...(baseline.imageProvenance ? { imageProvenance: baseline.imageProvenance } : {}),
          });
        }
      } catch (error) {
        if (rotated || !changedApplied) throw error;
        const compensationFailures: string[] = [];
        try {
          await applyServiceTargets(
            config,
            Object.fromEntries(Object.keys(changed).map((workload) => [workload, before.tasks[workload]!])),
            Object.fromEntries(Object.keys(changed).map((workload) => [workload, before.counts[workload]!])),
          );
        } catch (restoreError) {
          compensationFailures.push(`restoring pre-rotation task definitions: ${errMessage(restoreError)}`);
        }
        throwAfterCompensation(error, compensationFailures);
      }
      for (const workload of affected) step(`${workload}: restarted with rotated secrets`);
    });
  } finally {
    for (const secret of staged) rmSync(secret.dir, { recursive: true, force: true });
  }
  ok("operator secrets uploaded to AWS Secrets Manager");
}

export function githubTrustSubject(configDir: string, deployBranch?: string, deployEnvironment?: string): string {
  const tfvars = join(configDir, "infra", "terraform.tfvars");
  const source = existsSync(tfvars) ? readFileSync(tfvars, "utf8") : undefined;
  const tfValue = (name: string): string | undefined => {
    const raw = source?.match(new RegExp(`^${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"))?.[1];
    return raw ? (JSON.parse(raw) as string) : undefined;
  };
  let repo = process.env.GITHUB_REPOSITORY;
  if (!repo && source !== undefined) {
    repo = tfValue("github_repository");
    if (!repo || repo === "replace-me/repository" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error("infra/terraform.tfvars must set an explicit github_repository owner/name");
    }
  }
  if (!repo) {
    const remote = capture("git", ["-C", configDir, "config", "--get", "remote.origin.url"]).trim();
    repo = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/)?.[1];
    if (!repo) throw new Error("cannot derive the GitHub repository from this deployment checkout");
  }
  const configuredPrefix = tfValue("github_subject_prefix");
  if (
    configuredPrefix !== undefined &&
    configuredPrefix !== "" &&
    !/^repo:[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+$/.test(configuredPrefix)
  ) {
    throw new Error("infra/terraform.tfvars github_subject_prefix must be an exact repo:owner/repository prefix");
  }
  const subjectPrefix = configuredPrefix || `repo:${repo}`;
  if (deployEnvironment) return `${subjectPrefix}:environment:${deployEnvironment}`;
  const tfRef = tfValue("github_ref");
  if (tfRef !== undefined && !/^refs\/heads\/\S+$/.test(tfRef)) {
    throw new Error("infra/terraform.tfvars github_ref must be a refs/heads/* branch ref");
  }
  const ref = deployBranch ? `refs/heads/${deployBranch}` : (tfRef ?? "refs/heads/main");
  return `${subjectPrefix}:ref:${ref}`;
}

export function assertGithubDeployTrust(statements: unknown, accountId: string, expectedSubject: string): void {
  let list: unknown[] = [];
  if (Array.isArray(statements)) list = statements;
  else if (statements) list = [statements];
  if (list.length !== 1 || typeof list[0] !== "object" || list[0] === null || Array.isArray(list[0])) {
    throw new Error("deploy role must have exactly one trust statement");
  }
  const statement = list[0] as Record<string, unknown>;
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  if (statement.Effect !== "Allow" || actions.length !== 1 || actions[0] !== "sts:AssumeRoleWithWebIdentity") {
    throw new Error("deploy role trust must only allow GitHub OIDC assumption");
  }
  const principal = statement.Principal as Record<string, unknown> | undefined;
  if (
    principal?.Federated !== `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com` ||
    Object.keys(principal).length !== 1
  ) {
    throw new Error("deploy role trust must name only the account's GitHub OIDC provider");
  }
  const condition = statement.Condition as Record<string, unknown> | undefined;
  const equals = condition?.StringEquals as Record<string, unknown> | undefined;
  const live = equals?.["token.actions.githubusercontent.com:sub"];
  const rawSubjects: unknown[] = Array.isArray(live) ? live : [live].filter((s) => s !== undefined);
  const withoutIdPins = (subject: string): string =>
    subject.replace(/^repo:([^/:@]+)(?:@\d+)?\/([^/:@]+)(?:@\d+)?:/, "repo:$1/$2:");
  const expectedPinsIds = withoutIdPins(expectedSubject) !== expectedSubject;
  const subjects = expectedPinsIds
    ? rawSubjects
    : rawSubjects.map((subject) => (typeof subject === "string" ? withoutIdPins(subject) : subject));
  const repoPrefix = `${expectedSubject.split(":").slice(0, 2).join(":")}:`;
  if (
    !condition ||
    Object.keys(condition).length !== 1 ||
    !equals ||
    Object.keys(equals).length !== 2 ||
    equals["token.actions.githubusercontent.com:aud"] !== "sts.amazonaws.com" ||
    !subjects.includes(expectedSubject) ||
    !subjects.every(
      (subject) => typeof subject === "string" && subject.startsWith(repoPrefix) && !subject.includes("*"),
    )
  ) {
    const rendered = rawSubjects.length > 0 ? rawSubjects.join(", ") : "missing";
    throw new Error(
      `OIDC trust must pin audience and only ${repoPrefix}* subjects including ${expectedSubject} (live subject: ${rendered})`,
    );
  }
}

export function assertAwsPublicListener(
  publicUrl: string,
  listener: { Protocol?: string; Port?: number; Certificates?: Array<{ CertificateArn?: string }> },
): void {
  const protocol = new URL(publicUrl).protocol;
  if (protocol === "https:") {
    if (listener.Protocol !== "HTTPS" || listener.Port !== 443) {
      throw new Error(
        `publicUrl is HTTPS but the ALB listener is ${listener.Protocol ?? "missing"}:${listener.Port ?? "missing"}; configure certificate_arn and apply Terraform`,
      );
    }
    if (!listener.Certificates?.some((certificate) => Boolean(certificate.CertificateArn))) {
      throw new Error(
        "publicUrl is HTTPS but the ALB listener has no certificate; configure certificate_arn and apply Terraform",
      );
    }
    return;
  }
  if (protocol === "http:") {
    if (listener.Protocol !== "HTTP" || listener.Port !== 80) {
      throw new Error(
        `publicUrl is HTTP but the ALB listener is ${listener.Protocol ?? "missing"}:${listener.Port ?? "missing"}`,
      );
    }
    return;
  }
  throw new Error(`publicUrl must use http or https (got ${protocol})`);
}

interface AwsPublicListener {
  ListenerArn?: string;
  Protocol?: string;
  Port?: number;
  Certificates?: Array<{ CertificateArn?: string }>;
  DefaultActions?: Array<{
    Type?: string;
    TargetGroupArn?: string;
    FixedResponseConfig?: { StatusCode?: string };
    RedirectConfig?: { Protocol?: string; Port?: string; StatusCode?: string };
  }>;
}

interface AwsPublicFrontDoor {
  loadBalancerArn: string;
  dnsName: string;
  listener: AwsPublicListener;
}

function awsPublicOrigin(config: QmConfig): URL {
  const value = config.env.core?.AWS_PUBLIC_ORIGIN_URL?.trim() || config.publicUrl;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    return url;
  } catch {
    throw new Error("env.core.AWS_PUBLIC_ORIGIN_URL must be an HTTP(S) URL when set");
  }
}

function isHttpsRedirectListener(listener: AwsPublicListener): boolean {
  if (listener.Protocol !== "HTTP" || listener.Port !== 80) return false;
  const actions = listener.DefaultActions ?? [];
  return actions.length === 1 && actions[0]?.Type === "redirect" && actions[0].RedirectConfig?.Protocol === "HTTPS";
}

interface AwsServiceConnectConfiguration {
  enabled?: boolean;
  namespace?: string;
  services?: Array<{
    portName?: string;
    discoveryName?: string;
    clientAliases?: Array<{ dnsName?: string; port?: number }>;
  }>;
}

interface AwsEcsRoutingService {
  serviceName?: string;
  status?: string;
  serviceConnectConfiguration?: AwsServiceConnectConfiguration;
  deployments?: Array<{
    status?: string;
    serviceConnectConfiguration?: AwsServiceConnectConfiguration;
  }>;
  loadBalancers?: Array<{
    targetGroupArn?: string;
    advancedConfiguration?: {
      alternateTargetGroupArn?: string;
      productionListenerRule?: string;
    };
  }>;
}

function awsServiceConnectConfiguration(
  service: Pick<AwsEcsRoutingService, "serviceConnectConfiguration" | "deployments">,
): AwsServiceConnectConfiguration | undefined {
  return (
    service.serviceConnectConfiguration ??
    service.deployments?.find((deployment) => deployment.status === "PRIMARY")?.serviceConnectConfiguration
  );
}

function awsEcsRoutingServices(config: QmConfig): ReadonlyMap<string, AwsEcsRoutingService> {
  const aws = requireAws(config);
  const entries = deployedAwsServices(aws).map((name) => [name, aws.services[name]!] as const);
  const services: AwsEcsRoutingService[] = [];
  const failures: Array<{ arn?: string; reason?: string }> = [];
  for (const batch of chunks(
    entries.map(([, spec]) => spec.ecsService),
    ECS_SERVICE_BATCH_SIZE,
  )) {
    const described = awsJson<{
      services?: AwsEcsRoutingService[];
      failures?: Array<{ arn?: string; reason?: string }>;
    }>(aws, ["ecs", "describe-services", "--cluster", aws.cluster, "--services", ...batch]);
    services.push(...(described.services ?? []));
    failures.push(...(described.failures ?? []));
  }
  if (failures.length) {
    throw new Error(
      `could not describe ECS routing attachments: ${failures.map((failure) => `${failure.arn ?? "unknown"} (${failure.reason ?? "unknown"})`).join(", ")}`,
    );
  }
  return new Map(
    entries.map(([name, spec]) => {
      const service = services.find((candidate) => candidate.serviceName === spec.ecsService);
      if (!service) throw new Error(`ECS service ${spec.ecsService} is missing`);
      return [name, service] as const;
    }),
  );
}

function awsPublicFrontDoor(config: QmConfig): AwsPublicFrontDoor {
  const aws = requireAws(config);
  const albName =
    aws.alb ?? `${aws.cluster.slice(0, 23)}-${createHash("sha1").update(aws.cluster).digest("hex").slice(0, 8)}`;
  const loadBalancer = awsJson<{
    LoadBalancers?: Array<{ LoadBalancerArn?: string; DNSName?: string; State?: { Code?: string } }>;
  }>(aws, ["elbv2", "describe-load-balancers", "--names", albName]).LoadBalancers?.[0];
  if (!loadBalancer?.LoadBalancerArn || !loadBalancer.DNSName || loadBalancer.State?.Code !== "active") {
    throw new Error(`load balancer is ${loadBalancer?.State?.Code ?? "missing"}`);
  }
  const listeners =
    awsJson<{ Listeners?: AwsPublicListener[] }>(aws, [
      "elbv2",
      "describe-listeners",
      "--load-balancer-arn",
      loadBalancer.LoadBalancerArn,
    ]).Listeners ?? [];
  const origin = awsPublicOrigin(config);
  const httpsFrontDoor = origin.protocol === "https:";
  const redirects = httpsFrontDoor ? listeners.filter(isHttpsRedirectListener) : [];
  const candidates = listeners.filter((listener) => !redirects.includes(listener));
  if (candidates.length !== 1 || redirects.length > 1) {
    const found = listeners
      .map(
        (listener) =>
          `${listener.Protocol ?? "unknown"}:${listener.Port ?? "?"} (default ${listener.DefaultActions?.map((action) => action.Type ?? "unknown").join("+") || "none"})`,
      )
      .join(", ");
    throw new Error(
      `expected exactly one public listener${httpsFrontDoor ? " plus at most one port-80 HTTPS-redirect listener" : ""}, found ${found || "none"}`,
    );
  }
  const listener = candidates[0];
  if (!listener?.ListenerArn) throw new Error("public listener is missing");
  assertAwsPublicListener(origin.toString(), listener);
  return { loadBalancerArn: loadBalancer.LoadBalancerArn, dnsName: loadBalancer.DNSName, listener };
}

const validAlbHostname = (value: string): boolean =>
  value.length <= 253 &&
  value.includes(".") &&
  value
    .split(".")
    .every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));

function assertCloudFrontLayerTarget(config: QmConfig, url: URL, target: string): void {
  interface Distribution {
    DomainName?: string;
    Status?: string;
    Enabled?: boolean;
    ContinuousDeploymentPolicyId?: string;
    CacheBehaviors?: { Quantity?: number };
    DefaultCacheBehavior?: {
      TargetOriginId?: string;
      MaxTTL?: number;
      CachePolicyId?: string;
      FunctionAssociations?: { Quantity?: number };
      LambdaFunctionAssociations?: { Quantity?: number };
    };
    Origins?: {
      Items?: Array<{
        Id?: string;
        DomainName?: string;
        OriginPath?: string;
        CustomOriginConfig?: { OriginProtocolPolicy?: string; HTTPPort?: number };
      }>;
    };
  }
  const distributions =
    awsJson<{ DistributionList?: { Items?: Distribution[] } }>(requireAws(config), ["cloudfront", "list-distributions"])
      .DistributionList?.Items ?? [];
  const matches = distributions.filter((distribution) => distribution.DomainName === url.hostname);
  const distribution = matches.length === 1 ? matches[0] : undefined;
  const behavior = distribution?.DefaultCacheBehavior;
  const origin = distribution?.Origins?.Items?.find((item) => item.Id === behavior?.TargetOriginId);
  if (
    !distribution?.Enabled ||
    distribution.Status !== "Deployed" ||
    distribution.ContinuousDeploymentPolicyId ||
    behavior?.MaxTTL !== 0 ||
    behavior.CachePolicyId ||
    distribution.CacheBehaviors?.Quantity !== 0 ||
    (behavior?.FunctionAssociations?.Quantity ?? 0) !== 0 ||
    (behavior?.LambdaFunctionAssociations?.Quantity ?? 0) !== 0 ||
    origin?.DomainName?.toLowerCase().replace(/\.$/, "") !== target ||
    origin.OriginPath ||
    origin.CustomOriginConfig?.OriginProtocolPolicy !== "http-only" ||
    origin.CustomOriginConfig.HTTPPort !== 80 ||
    (url.port && url.port !== "443")
  ) {
    throw new CliError(
      "AWS deployment-layer HTTPS proxy must be a deployed CloudFront distribution routing directly to the selected ALB without alternate behaviors, origin paths, or edge functions",
    );
  }
}

function awsCoreHostnames(config: QmConfig): string[] {
  const hosts: string[] = [];
  const normalize = (value: string, source: string): string => {
    const host = value.trim().toLowerCase().replace(/\.$/, "");
    if (!validAlbHostname(host)) {
      throw new Error(`${source} ${JSON.stringify(value)} does not derive a valid ALB host-header hostname`);
    }
    return host;
  };
  const api = config.apiUrl?.trim();
  if (api) {
    let hostname: string;
    try {
      hostname = new URL(api).hostname;
    } catch {
      throw new Error(
        `apiUrl ${JSON.stringify(api)} is not a valid URL, so the ALB host rule for the core API cannot be derived`,
      );
    }
    const apiHost = normalize(hostname, "apiUrl");
    if (apiHost !== new URL(config.publicUrl).hostname.toLowerCase().replace(/\.$/, "")) hosts.push(apiHost);
  }
  const apps = config.env.core?.DEPLOY_APPS_DOMAIN?.trim() || config.env.core?.AWS_DEPLOY_APPS_DOMAIN?.trim();
  if (apps)
    hosts.push(`*.${normalize(apps, "the apps domain (env.core.DEPLOY_APPS_DOMAIN or AWS_DEPLOY_APPS_DOMAIN)")}`);
  return [...new Set(hosts)];
}

export function assertAwsPublicRouting(
  config: QmConfig,
  ecsServices?: ReadonlyMap<string, AwsEcsRoutingService>,
): ReadonlyMap<string, string> {
  const aws = requireAws(config);
  const hash = (value: string, length: number): string =>
    createHash("sha1").update(value).digest("hex").slice(0, length);
  const targetName = (name: string): string =>
    aws.services[name]?.targetGroup ??
    `${aws.cluster.slice(0, 20)}-${name.replaceAll("-", "").slice(0, 4)}-${hash(`${aws.cluster}:${name}`, 6)}`;
  const hasPortal = Boolean(aws.services.portal);
  const coreHosts = hasPortal ? awsCoreHostnames(config) : [];
  let ingress = ["core"];
  if (hasPortal) ingress = coreHosts.length ? ["portal", "core"] : ["portal"];
  const publicPaths = new Map(
    Object.entries(aws.services).flatMap(([name, service]) =>
      service?.publicPaths?.length ? [[name, service.publicPaths] as const] : [],
    ),
  );
  ingress.push(...publicPaths.keys());
  const { loadBalancerArn, listener } = awsPublicFrontDoor(config);
  const targetGroups =
    awsJson<{ TargetGroups?: Array<{ TargetGroupArn?: string; TargetGroupName?: string }> }>(aws, [
      "elbv2",
      "describe-target-groups",
      "--load-balancer-arn",
      loadBalancerArn,
    ]).TargetGroups ?? [];
  const routingServices = ecsServices ?? awsEcsRoutingServices(config);
  const targets = new Map<string, string>();
  const alternateTargets = new Map<string, string>();
  const productionRules = new Map<string, string>();
  const expectedTargetArns = new Set<string>();
  for (const name of ingress) {
    const expectedName = targetName(name);
    const target = targetGroups.find((group) => group.TargetGroupName === expectedName);
    if (!target?.TargetGroupArn) throw new Error(`target group for ${name} is missing`);
    targets.set(name, target.TargetGroupArn);
    expectedTargetArns.add(target.TargetGroupArn);
    const attachment = (routingServices.get(name)?.loadBalancers ?? []).find(
      (item) => item.targetGroupArn === target.TargetGroupArn,
    );
    if (!attachment) {
      throw new Error(`ECS service ${name} is not attached to its target group`);
    }
    const alternate = attachment.advancedConfiguration?.alternateTargetGroupArn;
    const productionRule = attachment.advancedConfiguration?.productionListenerRule;
    if (Boolean(alternate) !== Boolean(productionRule)) {
      throw new Error(`ECS service ${name} has an incomplete blue/green load-balancer configuration`);
    }
    if (alternate && productionRule) {
      if (!targetGroups.some((group) => group.TargetGroupArn === alternate)) {
        throw new Error(`alternate target group for ${name} is missing`);
      }
      alternateTargets.set(name, alternate);
      productionRules.set(name, productionRule);
      expectedTargetArns.add(alternate);
    }
  }
  for (const name of deployedAwsServices(aws)) {
    if (!ingress.includes(name) && (routingServices.get(name)?.loadBalancers ?? []).length) {
      throw new Error(`private ECS service ${name} is attached to a load balancer`);
    }
  }
  if (
    targetGroups.length !== expectedTargetArns.size ||
    targetGroups.some((group) => !group.TargetGroupArn || !expectedTargetArns.has(group.TargetGroupArn))
  ) {
    throw new Error("ALB has target groups for private or unknown services");
  }
  if (alternateTargets.size && alternateTargets.size !== ingress.length) {
    throw new Error("ALB cannot mix rolling and blue/green ingress services");
  }
  const defaults = listener.DefaultActions ?? [];
  if (alternateTargets.size) {
    if (
      defaults.length !== 1 ||
      defaults[0]?.Type !== "fixed-response" ||
      defaults[0].FixedResponseConfig?.StatusCode !== "404" ||
      defaults[0].TargetGroupArn
    ) {
      throw new Error("blue/green listener default must return a fixed 404 response");
    }
  } else if (hasPortal) {
    if (
      defaults.length !== 1 ||
      defaults[0]?.Type !== "forward" ||
      defaults[0].TargetGroupArn !== targets.get("portal")
    ) {
      throw new Error("portal listener default does not route only to portal");
    }
  } else if (
    defaults.length !== 1 ||
    defaults[0]?.Type !== "fixed-response" ||
    defaults[0].FixedResponseConfig?.StatusCode !== "404" ||
    defaults[0].TargetGroupArn
  ) {
    throw new Error("non-portal listener default must return a fixed 404 response");
  }
  const rules =
    awsJson<{
      Rules?: Array<{
        RuleArn?: string;
        Priority?: string;
        IsDefault?: boolean;
        Actions?: Array<{
          Type?: string;
          TargetGroupArn?: string;
          ForwardConfig?: { TargetGroups?: Array<{ TargetGroupArn?: string; Weight?: number }> };
        }>;
        Conditions?: Array<{
          Field?: string;
          Values?: string[];
          PathPatternConfig?: { Values?: string[] };
          HostHeaderConfig?: { Values?: string[] };
        }>;
      }>;
    }>(aws, ["elbv2", "describe-rules", "--listener-arn", listener.ListenerArn!]).Rules ?? [];
  let nonDefault = rules.filter((rule) => !rule.IsDefault);
  const pluginRules = new Set<(typeof nonDefault)[number]>();
  for (const [name, paths] of publicPaths) {
    const matches = nonDefault.filter((rule) =>
      alternateTargets.size
        ? rule.RuleArn === productionRules.get(name)
        : rule.Actions?.length === 1 &&
          rule.Actions[0]?.Type === "forward" &&
          rule.Actions[0]?.TargetGroupArn === targets.get(name),
    );
    const rule = matches[0];
    const condition = rule?.Conditions?.length === 1 ? rule.Conditions[0] : undefined;
    const actual =
      condition?.Field === "path-pattern" ? (condition.PathPatternConfig?.Values ?? condition.Values ?? []) : [];
    if (
      matches.length !== 1 ||
      !rule ||
      actual.length !== paths.length ||
      paths.some((path) => !actual.includes(path))
    ) {
      throw new Error(`public plugin ${name} must route exactly its declared publicPaths`);
    }
    pluginRules.add(rule);
  }
  for (const rule of pluginRules) {
    const priority = Number(rule.Priority);
    if (
      !Number.isInteger(priority) ||
      priority < 1 ||
      nonDefault.some(
        (other) =>
          !pluginRules.has(other) && (!Number.isInteger(Number(other.Priority)) || priority >= Number(other.Priority)),
      )
    ) {
      throw new Error("public plugin routes must precede core and portal routes");
    }
  }

  if (alternateTargets.size) {
    if (nonDefault.length !== ingress.length) {
      throw new Error("blue/green ALB has unexpected non-default rules");
    }
    for (const name of ingress) {
      const rule = nonDefault.find((candidate) => candidate.RuleArn === productionRules.get(name));
      const action = rule?.Actions?.length === 1 ? rule.Actions[0] : undefined;
      const weightedTargets = action?.ForwardConfig?.TargetGroups ?? [];
      const primary = targets.get(name)!;
      const alternate = alternateTargets.get(name)!;
      const expected = new Set([primary, alternate]);
      const active = weightedTargets.filter((target) => (target.Weight ?? 0) > 0);
      if (
        action?.Type !== "forward" ||
        weightedTargets.length !== 2 ||
        weightedTargets.some((target) => !target.TargetGroupArn || !expected.has(target.TargetGroupArn)) ||
        active.length !== 1 ||
        !active[0]?.TargetGroupArn
      ) {
        throw new Error(`blue/green ALB rule for ${name} must route to exactly one of its two target groups`);
      }
      const condition = rule?.Conditions?.length === 1 ? rule.Conditions[0] : undefined;
      const pathValues =
        condition?.Field === "path-pattern" ? (condition.PathPatternConfig?.Values ?? condition.Values ?? []) : [];
      const hostValues =
        condition?.Field === "host-header" ? (condition.HostHeaderConfig?.Values ?? condition.Values ?? []) : [];
      let expectedPaths: string[];
      if (publicPaths.has(name)) expectedPaths = publicPaths.get(name)!;
      else if (name === "portal") expectedPaths = ["/*"];
      else if (hasPortal) expectedPaths = [];
      else expectedPaths = ["/v1/*"];
      const expectedHosts = name === "core" && hasPortal ? coreHosts : [];
      if (
        pathValues.length !== expectedPaths.length ||
        expectedPaths.some((value) => !pathValues.includes(value)) ||
        hostValues.length !== expectedHosts.length ||
        expectedHosts.some((value) => !hostValues.map((host) => host.toLowerCase()).includes(value))
      ) {
        throw new Error(`blue/green ALB rule for ${name} does not match its production route`);
      }
      targets.set(name, active[0].TargetGroupArn);
    }
    return targets;
  }
  nonDefault = nonDefault.filter((rule) => !pluginRules.has(rule));
  if (hasPortal && !coreHosts.length && nonDefault.length)
    throw new Error("portal mode must not expose non-default ALB rules");
  if (hasPortal && coreHosts.length) {
    const found: string[] = [];
    for (const rule of nonDefault) {
      const action = rule.Actions?.length === 1 ? rule.Actions[0] : undefined;
      const condition = rule.Conditions?.length === 1 ? rule.Conditions[0] : undefined;
      const values =
        condition?.Field === "host-header" ? (condition.HostHeaderConfig?.Values ?? condition.Values ?? []) : [];
      if (action?.Type !== "forward" || action.TargetGroupArn !== targets.get("core") || !values.length) {
        throw new Error(
          `portal ALB has a non-default rule that is not a single host-header forward to core (expected only ${coreHosts.join(", ")})`,
        );
      }
      found.push(...values.map((value) => value.toLowerCase()));
    }
    if (found.length !== coreHosts.length || coreHosts.some((host) => !found.includes(host))) {
      throw new Error(
        `portal ALB host rules must route exactly ${coreHosts.join(", ")} to core (live: ${found.join(", ") || "none"})`,
      );
    }
  }
  if (!hasPortal) {
    const coreRule = nonDefault.filter(
      (rule) =>
        rule.Actions?.length === 1 &&
        rule.Actions[0]?.Type === "forward" &&
        rule.Actions[0].TargetGroupArn === targets.get("core") &&
        rule.Conditions?.length === 1 &&
        rule.Conditions[0]?.Field === "path-pattern" &&
        rule.Conditions[0].PathPatternConfig?.Values?.length === 1 &&
        rule.Conditions[0].PathPatternConfig.Values[0] === "/v1/*",
    );
    if (coreRule.length !== 1) {
      throw new Error("non-portal ALB must route only /v1/* directly to core");
    }
    if (nonDefault.length !== 1) throw new Error("non-portal ALB has unexpected non-default rules");
  }
  return targets;
}

function assertAwsPublicFrontDoor(config: QmConfig): void {
  try {
    assertAwsPublicRouting(config);
  } catch (error) {
    throw new CliError(`AWS public front door is not ready for deployment: ${errMessage(error)}`);
  }
}

async function assertAwsPublicNetwork(config: QmConfig, rejectServerErrors = false): Promise<void> {
  const originHostname = awsPublicOrigin(config).hostname.toLowerCase().replace(/\.$/, "");
  const albHostname = awsPublicFrontDoor(config).dnsName.toLowerCase().replace(/\.$/, "");
  if (originHostname !== albHostname) {
    const [cnames, publicAddresses, albAddresses] = await Promise.all([
      resolveCname(originHostname).catch(() => []),
      lookup(originHostname, { all: true })
        .then((values) => values.map((value) => value.address))
        .catch(() => []),
      lookup(albHostname, { all: true })
        .then((values) => values.map((value) => value.address))
        .catch(() => []),
    ]);
    const cnameMatch = cnames.some((name) => name.toLowerCase().replace(/\.$/, "") === albHostname);
    const albSet = new Set(albAddresses);
    const addressMatch = publicAddresses.some((address) => albSet.has(address));
    if (!cnameMatch && !addressMatch) {
      throw new CliError(`AWS public origin ${originHostname} does not resolve to this stack's ALB ${albHostname}`);
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(config.publicUrl, { redirect: "manual", signal: controller.signal });
    await response.body?.cancel();
    if (rejectServerErrors && response.status >= 500) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new CliError(`AWS public URL is not reachable with trusted TLS and matching DNS: ${errMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function assertAwsHealthyIngress(config: QmConfig, targets: ReadonlyMap<string, string>): void {
  const aws = requireAws(config);
  for (const [name, targetGroupArn] of targets) {
    const health =
      awsJson<{ TargetHealthDescriptions?: Array<{ TargetHealth?: { State?: string; Reason?: string } }> }>(aws, [
        "elbv2",
        "describe-target-health",
        "--target-group-arn",
        targetGroupArn,
      ]).TargetHealthDescriptions ?? [];
    if (!health.some((target) => target.TargetHealth?.State === "healthy")) {
      const states = health.map(
        (target) =>
          `${target.TargetHealth?.State ?? "unknown"}${target.TargetHealth?.Reason ? ` (${target.TargetHealth.Reason})` : ""}`,
      );
      throw new Error(`${name} target group has no healthy targets${states.length ? `: ${states.join(", ")}` : ""}`);
    }
  }
}

export function assertAwsDeploymentStorage(config: QmConfig): void {
  const aws = requireAws(config);
  const tableName = deployLocksTable(aws);
  const table = awsJson<{ Table?: { TableStatus?: string } }>(aws, [
    "dynamodb",
    "describe-table",
    "--table-name",
    tableName,
  ]).Table;
  if (table?.TableStatus !== "ACTIVE")
    throw new Error(`deploy-lock table ${tableName} is ${table?.TableStatus ?? "missing"}`);
  awsText(aws, [
    "s3api",
    "list-objects-v2",
    "--bucket",
    awsObjectStoreBucket(config),
    "--prefix",
    "deployment/",
    "--max-keys",
    "1",
  ]);
}

export function probeAwsSecretStore(
  secrets: ComputedSecret[],
  read: (name: string) => string,
  checkPublicApiUrl: () => void,
): { values: Map<string, string>; pending: string[]; failures: string[] } {
  const values = new Map<string, string>();
  const pending: string[] = [];
  const failures: string[] = [];
  for (const secret of secrets) {
    const label = secret.required ? `secret ${secret.name}` : `optional secret ${secret.name}`;
    try {
      const value = read(secret.name);
      if (isInvalidSecret(secret.name, value)) throw new Error("missing, placeholder, or insecure value");
      values.set(secret.name, value);
      if (secret.required && secret.name === "PUBLIC_API_URL") checkPublicApiUrl();
      step(secret.required ? `${label}: ok` : `${label}: configured`);
    } catch (error) {
      if (/ResourceNotFoundException/.test(errMessage(error))) {
        if (secret.required) {
          pending.push(secret.name);
          step(`${label}: not pushed yet — run \`qm secrets push\` before the first deploy`);
        } else {
          warn(`${label}: not configured`);
        }
      } else {
        failures.push(`${label}: ${errMessage(error)}`);
        warn(`${label}: failed`);
      }
    }
  }
  return { values, pending, failures };
}

export async function awsDoctor(config: QmConfig, configDir: string): Promise<void> {
  const { aws } = awsTopology(config, configDir);
  header(`qm doctor — ${config.orgId} (aws)`);
  assertAwsCallerAccount(aws);
  step("AWS caller account: ok");
  const failures: string[] = [];
  const check = (label: string, fn: () => void): void => {
    try {
      fn();
      step(`${label}: ok`);
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
      warn(`${label}: failed`);
    }
  };
  const checkAsync = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      step(`${label}: ok`);
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
      warn(`${label}: failed`);
    }
  };
  const tfvarsPath = join(configDir, "infra", "terraform.tfvars");
  if (existsSync(tfvarsPath))
    check("Terraform coordinates", () => {
      const path = tfvarsPath;
      const existing = readFileSync(path, "utf8");
      const variablesPath = join(configDir, "infra", "variables.tf");
      const declared = existsSync(variablesPath) ? declaredVariables(readFileSync(variablesPath, "utf8")) : [];
      const drift = terraformVarsDrift(config, existing, declared);
      if (drift.length)
        throw new Error(`terraform.tfvars drift (${drift.join(", ")}); run \`qm infra render\` and commit the result`);
    });
  else step("Terraform coordinates: external infrastructure (no vendored infra/terraform.tfvars)");
  check("ECS cluster", () => {
    const cluster = awsJson<{ clusters?: Array<{ status?: string }> }>(aws, [
      "ecs",
      "describe-clusters",
      "--clusters",
      aws.cluster,
    ]).clusters?.[0];
    if (cluster?.status !== "ACTIVE") throw new Error(`cluster is ${cluster?.status ?? "missing"}`);
  });
  check("deployment state stores", () => assertAwsDeploymentStorage(config));
  const snapshotBucket = config.env.core?.S3_BUCKET?.trim();
  if (snapshotBucket)
    check(`core S3 bucket ${snapshotBucket}`, () => {
      try {
        awsText(aws, ["s3api", "head-bucket", "--bucket", snapshotBucket]);
      } catch (error) {
        throw new Error(`the env.core.S3_BUCKET override is missing or not readable: ${errMessage(error)}`, {
          cause: error,
        });
      }
    });
  check("Lambda MicroVM deploy image", () => assertAwsDeployImage(config));
  check("deploy role", () => {
    const expectedSubject = githubTrustSubject(configDir, aws.deployBranch, aws.deployEnvironment);
    const role = awsJson<{ Role?: { Arn?: string; AssumeRolePolicyDocument?: { Statement?: unknown } } }>(aws, [
      "iam",
      "get-role",
      "--role-name",
      aws.deployRoleArn.split("/").pop()!,
    ]);
    if (role.Role?.Arn !== aws.deployRoleArn) throw new Error("role ARN differs from config");
    assertGithubDeployTrust(role.Role.AssumeRolePolicyDocument?.Statement, aws.accountId, expectedSubject);
    if (process.env.GITHUB_ACTIONS === "true") {
      const caller = awsJson<{ Arn?: string }>(aws, ["sts", "get-caller-identity"]);
      const roleName = aws.deployRoleArn.split("/").pop()!;
      if (!caller.Arn?.includes(`:assumed-role/${roleName}/`))
        throw new Error("workflow is not actually running as the configured deploy role");
    }
  });
  check("GitHub OIDC provider", () => {
    const arn = `arn:aws:iam::${aws.accountId}:oidc-provider/token.actions.githubusercontent.com`;
    const provider = awsJson<{ Url?: string; ClientIDList?: string[] }>(aws, [
      "iam",
      "get-open-id-connect-provider",
      "--open-id-connect-provider-arn",
      arn,
    ]);
    if (provider.Url !== "token.actions.githubusercontent.com")
      throw new Error("GitHub OIDC provider URL is incorrect");
    if (!provider.ClientIDList?.includes("sts.amazonaws.com"))
      throw new Error("GitHub OIDC provider does not trust sts.amazonaws.com");
  });
  check("RDS", () => {
    const database = awsJson<{
      DBInstances?: Array<{
        DBInstanceStatus?: string;
        Endpoint?: { Address?: string; Port?: number };
        VpcSecurityGroups?: Array<{ VpcSecurityGroupId?: string }>;
      }>;
    }>(aws, ["rds", "describe-db-instances", "--db-instance-identifier", rdsInstanceIdentifier(aws)]).DBInstances?.[0];
    if (database?.DBInstanceStatus !== "available")
      throw new Error(`database is ${database?.DBInstanceStatus || "missing"}`);
    const coreService = aws.services.core;
    if (!coreService) throw new Error("aws.services.core is missing");
    const coreGroups =
      awsJson<{ services?: Array<{ networkConfiguration?: { awsvpcConfiguration?: { securityGroups?: string[] } } }> }>(
        aws,
        ["ecs", "describe-services", "--cluster", aws.cluster, "--services", coreService.ecsService],
      ).services?.[0]?.networkConfiguration?.awsvpcConfiguration?.securityGroups ?? [];
    const databaseGroups = (database.VpcSecurityGroups ?? []).flatMap((group) =>
      group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
    );
    const permissions = databaseGroups.length
      ? (awsJson<{
          SecurityGroups?: Array<{
            IpPermissions?: Array<{
              IpProtocol?: string;
              FromPort?: number;
              ToPort?: number;
              UserIdGroupPairs?: Array<{ GroupId?: string }>;
            }>;
          }>;
        }>(aws, ["ec2", "describe-security-groups", "--group-ids", ...databaseGroups]).SecurityGroups?.flatMap(
          (group) => group.IpPermissions ?? [],
        ) ?? [])
      : [];
    const reachable = permissions.some(
      (permission) =>
        permission.IpProtocol === "tcp" &&
        (permission.FromPort ?? Infinity) <= 5432 &&
        (permission.ToPort ?? -Infinity) >= 5432 &&
        (permission.UserIdGroupPairs ?? []).some((pair) => pair.GroupId && coreGroups.includes(pair.GroupId)),
    );
    if (!reachable) throw new Error("database security groups do not allow the core ECS service on port 5432");
    const databaseUrl = awsText(aws, [
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      `${aws.secretsPrefix}DATABASE_URL`,
      "--query",
      "SecretString",
    ]);
    if (!database.Endpoint?.Address || new URL(databaseUrl).hostname !== database.Endpoint.Address)
      throw new Error("DATABASE_URL does not point at the configured RDS endpoint");
  });
  const ecsServices = new Map<string, AwsEcsRoutingService>();
  for (const service of deployedAwsServices(aws)) {
    const spec = aws.services[service]!;
    check(`ECS service ${spec.ecsService}`, () => {
      const found = awsJson<{ services?: AwsEcsRoutingService[] }>(aws, [
        "ecs",
        "describe-services",
        "--cluster",
        aws.cluster,
        "--services",
        spec.ecsService,
      ]).services?.[0];
      if (found?.status !== "ACTIVE") throw new Error(`service is ${found?.status ?? "missing"}`);
      ecsServices.set(service, found);
    });
    check(`ECR ${spec.ecrRepository}`, () => {
      const repository = awsJson<{ repositories?: Array<{ repositoryArn?: string }> }>(aws, [
        "ecr",
        "describe-repositories",
        "--repository-names",
        spec.ecrRepository,
      ]).repositories?.[0];
      if (!repository?.repositoryArn) throw new Error("repository is missing");
    });
  }
  const logGroups = new Map<string, string[]>();
  for (const [name, spec] of Object.entries(aws.services)) {
    const group = spec.logGroup ?? `/ecs/${spec.ecsService}`;
    logGroups.set(group, [...(logGroups.get(group) ?? []), name]);
  }
  for (const [group, names] of logGroups) {
    check(`CloudWatch log group ${group}`, () => {
      const found =
        awsJson<{ logGroups?: Array<{ logGroupName?: string }> }>(aws, [
          "logs",
          "describe-log-groups",
          "--log-group-name-prefix",
          group,
        ]).logGroups ?? [];
      if (!found.some((item) => item.logGroupName === group)) {
        throw new Error(
          `log group is missing — the awslogs driver refuses to start ${names.join(", ")} without it; create it or fix aws.services.${names.join("/")}.logGroup`,
        );
      }
    });
  }
  check("Cloud Map routing", () => {
    const namespaces =
      awsJson<{ Namespaces?: Array<{ Id?: string; Name?: string }> }>(aws, ["servicediscovery", "list-namespaces"])
        .Namespaces ?? [];
    const namespace = namespaces.find((item) => item.Name === aws.networking.cloudMapNamespace);
    if (!namespace?.Id) throw new Error(`namespace ${aws.networking.cloudMapNamespace} is missing`);
    const services =
      awsJson<{ Services?: Array<{ Arn?: string; Name?: string }> }>(aws, [
        "servicediscovery",
        "list-services",
        "--filters",
        `Name=NAMESPACE_ID,Values=${namespace.Id},Condition=EQ`,
      ]).Services ?? [];
    for (const name of deployedAwsServices(aws)) {
      const discovery = services.find((service) => service.Name === name);
      if (!discovery?.Arn) throw new Error(`service ${name} is missing from ${aws.networking.cloudMapNamespace}`);
      const ecsService = ecsServices.get(name);
      const connect = ecsService ? awsServiceConnectConfiguration(ecsService) : undefined;
      if (!connect?.enabled) throw new Error(`ECS service ${name} does not have Service Connect enabled`);
      const endpoint = connect.services?.find((service) => service.discoveryName === name);
      const expectedDns = `${name}.${aws.networking.cloudMapNamespace}`;
      const expectedPort = isServiceName(name) ? serviceDef(name).docker.internalPort : 8080;
      if (endpoint?.portName !== name) {
        throw new Error(`ECS service ${name} does not publish its named ${name} port through Service Connect`);
      }
      if (!endpoint.clientAliases?.some((alias) => alias.dnsName === expectedDns && alias.port === expectedPort)) {
        throw new Error(`ECS service ${name} does not publish the ${expectedDns}:${expectedPort} client alias`);
      }
    }
  });
  check("ALB routing", () => assertAwsPublicRouting(config, ecsServices));
  await checkAsync("public URL DNS and TLS", () => assertAwsPublicNetwork(config));
  const runtimeSecrets = new Map<string, string>();
  for (const secret of computedSecrets(config)) {
    const inspect = (): void => {
      const id = `${aws.secretsPrefix}${secret.name}`;
      const value = awsText(aws, ["secretsmanager", "get-secret-value", "--secret-id", id, "--query", "SecretString"]);
      if (isInvalidSecret(secret.name, value)) throw new Error("missing, placeholder, or insecure value");
      runtimeSecrets.set(secret.name, value);
    };
    if (secret.required)
      check(`secret ${secret.name}`, () => {
        inspect();
        if (secret.name === "PUBLIC_API_URL") assertAwsPublicApiUrl(config);
      });
    else {
      try {
        inspect();
        step(`optional secret ${secret.name}: configured`);
      } catch (error) {
        if (/ResourceNotFoundException|AccessDeniedException/.test(errMessage(error)))
          warn(`optional secret ${secret.name}: not configured or not readable`);
        else {
          failures.push(`optional secret ${secret.name}: ${errMessage(error)}`);
          warn(`optional secret ${secret.name}: failed`);
        }
      }
    }
  }
  if (failures.length) throw new CliError(`doctor failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  const runtimeNames = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] as const;
  const priorRuntime = new Map(runtimeNames.map((name) => [name, process.env[name]]));
  for (const name of runtimeNames) {
    const stored = runtimeSecrets.get(name);
    if (stored !== undefined) process.env[name] = stored;
    else delete process.env[name];
  }
  try {
    await doctorCommon(config, runtimeSecrets, { configDir, requiredSecretValues: true });
  } finally {
    for (const name of runtimeNames) {
      const prior = priorRuntime.get(name);
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
  ok("all AWS deployment prerequisites are ready");
}

async function checkLive(
  config: QmConfig,
  opts: { report?: boolean; configDir?: string; envFile?: string; sandboxDir?: string } = {},
): Promise<void> {
  const configDir = opts.configDir ?? process.cwd();
  const { aws, workloads: services, plugins: resolvedPlugins } = awsTopology(config, configDir);
  const plugins = new Map(resolvedPlugins.map((plugin) => [plugin.name, plugin]));
  assertAwsCallerAccount(aws);
  const failures: string[] = [];
  try {
    assertAwsDeployImage(config);
  } catch (error) {
    failures.push(`deploy image drift: ${errMessage(error)}`);
  }
  const arns = secretArns(config);
  const states = describedServices(config, services);
  const manifest = currentDeploymentManifest(aws);
  if (!manifest)
    throw new CliError("live drift detected: no current AWS deployment manifest", { clause: "aws.live-drift" });
  const desiredImages: Record<string, string> = {};
  for (const service of services) {
    const provenance = manifest.imageProvenance?.[service];
    if (!provenance) continue;
    const plugin = plugins.get(service);
    if (provenance.kind === "source-build") {
      if (plugin?.kind === "image" || (isServiceName(service) && config.imageOverrides[service])) {
        failures.push(
          `${service}: image build provenance drift (deployed from source, current workload uses a configured image)`,
        );
      }
      continue;
    }
    if (plugin?.kind === "source") {
      failures.push(
        `${service}: image build provenance drift (deployed from a configured image, current workload builds from source)`,
      );
      continue;
    }
    const source = workloadSourceImage(config, service, plugin);
    if (!source) {
      failures.push(`${service}: configured image source is missing for prebuilt deployment`);
      continue;
    }
    try {
      desiredImages[service] = plannedWorkloadImage(config, service, plugin);
    } catch (error) {
      failures.push(`${service}: could not resolve desired image: ${errMessage(error)}`);
    }
  }
  if (manifest.imageLabel !== aws.imageLabel)
    failures.push(
      `deployment manifest label ${manifest.imageLabel ?? "missing"} does not match configured release ${aws.imageLabel ?? "missing"}`,
    );
  for (const service of services) {
    const state = states.get(service)!;
    const expectedTask = manifest.tasks[service];
    if (!expectedTask) {
      failures.push(`${service}: missing from current deployment manifest ${manifest.id}`);
      continue;
    }
    const primary = (state.deployments ?? []).filter((deployment) => deployment.status === "PRIMARY");
    const wantCount = workloadDesiredCount(config, service);
    const draining = primary[0]?.rolloutState === "IN_PROGRESS" && (primary[0]?.runningCount ?? 0) >= wantCount;
    if (
      state.status !== "ACTIVE" ||
      state.desiredCount !== wantCount ||
      (draining ? (state.runningCount ?? 0) < wantCount : state.runningCount !== wantCount)
    ) {
      failures.push(
        `${service}: runtime is ${state.status ?? "missing"} with ${state.runningCount ?? 0}/${state.desiredCount ?? 0} running, expected ${wantCount}`,
      );
    }
    if (
      primary.length !== 1 ||
      primary[0]?.taskDefinition !== state.taskDefinition ||
      (primary[0]?.rolloutState !== "COMPLETED" && !draining)
    ) {
      failures.push(`${service}: configured task is not the sole healthy PRIMARY deployment`);
    }
    if (state.taskDefinition !== expectedTask)
      failures.push(`${service}: service task does not match deployment manifest ${manifest.id}`);
    const live =
      awsJson<{ taskDefinition?: Record<string, unknown> }>(aws, [
        "ecs",
        "describe-task-definition",
        "--task-definition",
        expectedTask,
      ]).taskDefinition ?? null;
    if (!live) {
      failures.push(`${service}: no live task definition`);
      continue;
    }
    const container = (live.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
      (item) => item.name === service,
    );
    const liveEnv = Object.fromEntries(
      ((container?.environment as Array<{ name: string; value: string }> | undefined) ?? []).map((item) => [
        item.name,
        item.value,
      ]),
    );
    const expectedEnv = workloadEnvironment(config, service);
    if (canonicalJson(liveEnv) !== canonicalJson(expectedEnv))
      failures.push(`${service}: environment drift (including live-only keys)`);
    const expectedSecrets = workloadSecrets(config, service, arns)
      .flatMap((secret) => containerSecretNames(service, secret))
      .sort();
    const liveSecretEntries = (container?.secrets as Array<{ name: string; valueFrom?: string }> | undefined) ?? [];
    const liveSecrets = liveSecretEntries.map((secret) => secret.name).sort();
    if (JSON.stringify(liveSecrets) !== JSON.stringify(expectedSecrets)) failures.push(`${service}: secret-name drift`);
    const repository = expectedWorkloadImageRepository(config, service);
    if (typeof container?.image !== "string" || !isPinnedWorkloadImage(config, service, container.image)) {
      failures.push(`${service}: live image is not a digest from ${repository}`);
    } else {
      const desiredImage = desiredImages[service];
      if (desiredImage && container.image !== desiredImage) {
        failures.push(`${service}: image drift (live ${container.image}, desired ${desiredImage})`);
      }
      const comparisonImage = desiredImage ?? `${repository}@sha256:${"0".repeat(64)}`;
      const fields = taskDefinitionDiff(renderTaskDefinition(config, service, comparisonImage, arns), live).filter(
        (field) => desiredImage || field !== `taskDefinition.containerDefinitions.${service}.image`,
      );
      if (fields.length) failures.push(`${service}: task-definition drift (${fields.join(", ")})`);
    }
  }
  try {
    const targets = assertAwsPublicRouting(config);
    assertAwsHealthyIngress(config, targets);
  } catch (error) {
    failures.push(`public front-door drift: ${errMessage(error)}`);
  }
  try {
    await retryLiveProbe(() => assertAwsPublicNetwork(config, true));
  } catch (error) {
    failures.push(`public network drift: ${errMessage(error)}`);
  }
  if (!manifest.layer) {
    failures.push(`deployment manifest ${manifest.id} has no deployment-layer artifact`);
  } else {
    try {
      getDeploymentLayerArtifact(config, manifest.layer);
      if (opts.sandboxDir && existsSync(opts.sandboxDir)) {
        const directoryHash = createHash("sha256").update(deploymentLayerBody(opts.sandboxDir)).digest("hex");
        if (directoryHash !== manifest.layer.sha256)
          failures.push("deployment layer does not match the deployment directory");
      }
      await retryLiveProbe(async () => {
        const state = await currentDeploymentLayerState({
          config,
          transport: awsDeploymentLayerTransport,
          configDir,
          ...(opts.envFile ? { envFile: opts.envFile } : {}),
        });
        if (state.contentHash !== manifest.layer!.sha256)
          throw new Error("deployment layer content does not match the current manifest");
        if (state.status !== "applied" || state.runtimeContentHash !== manifest.layer!.sha256)
          throw new Error("deployment layer is not applied by the live core");
      });
    } catch (error) {
      failures.push(`deployment layer drift: ${errMessage(error)}`);
    }
  }
  if (!failures.length) {
    try {
      awsLiveSession(config, states.get("core")!);
      if (opts.report ?? true) step("core: private live session smoke passed");
    } catch (error) {
      failures.push(`core: private live session smoke failed: ${errMessage(error)}`);
    }
  }
  if (failures.length)
    throw new CliError(`live drift detected:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`, {
      clause: "aws.live-drift",
    });
  if (opts.report ?? true) ok("live AWS deployment matches the directory in both directions");
}

export async function awsCheckLive(
  config: QmConfig,
  opts: { report?: boolean; configDir?: string; envFile?: string; sandboxDir?: string } = {},
): Promise<void> {
  try {
    await checkLive(config, opts);
  } catch (error) {
    if (error instanceof CliError && error.clause === "aws.live-drift") throw error;
    throw new CliError(errMessage(error), { clause: "aws.live-drift", cause: error });
  }
}
