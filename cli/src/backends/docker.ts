import { httpDeploymentLayerTransport, type DeploymentLayerTransport } from "../deployment-layer.ts";

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError, bold, die, dim, errMessage, header, note, ok, step, warn } from "../log.ts";
import {
  capture,
  captureBoth,
  deploymentSecretValue,
  readEnvFile,
  resolveBuildRepoRoot,
  runInherit,
  sleep,
  streamLabeled,
  tailString,
  which,
} from "../util.ts";
import { manifestRef, sandboxBaseRef } from "../manifest.ts";
import {
  ordered,
  coreWorkloadEnv,
  hostsWebEdge,
  isCoreWorkload,
  isVirtualService,
  PUBLIC_PORT,
  runnableImages,
  runnableServices,
  hostedServiceEnv,
  serviceDef,
  serviceWorkloads,
  teardownOrdered,
  type ImageName,
  type LogOpts,
  type ServiceName,
} from "../services.ts";
import { dockerBasePort, localSandboxActive, sandboxCoreEnv, type QmConfig } from "../config.ts";
import { withoutTenantSettings } from "../tenant-setting-names.ts";
import { discoverPlugins, type ResolvedPlugin } from "../plugins.ts";
import { computedSecrets, missingRequiredSecrets, runtimeSecretNames, secretsForService } from "../secrets.ts";
import { doctorCommon, localDoctorSecrets } from "./doctor.ts";
import { DATABASE_LOGIN_ENV_NAMES, databaseLoginEnv } from "../database-logins.ts";
import {
  bootstrapDockerOwner,
  externalDockerOwnerUrl,
  managedDockerOwnerUrl,
  pgContainerPassword,
} from "./docker-postgres.ts";
import {
  deploymentDir,
  readDeploymentState,
  withDeploymentLock,
  writeDeploymentState,
  type DeploymentState,
} from "../state.ts";

/** Deployment-layer transport for docker: signed HTTP to the locally published core port. */
export const dockerDeploymentLayerTransport: DeploymentLayerTransport = httpDeploymentLayerTransport({
  urlOf: (config) => new URL(`http://127.0.0.1:${dockerBasePort(config)}/v1/deployment-layer`),
});

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "-");
const DEPLOYMENT_LABEL_KEY = "qm.org";
const deploymentLabelArgs = (ctx: DockerCtx): string[] => [
  "--label",
  `${DEPLOYMENT_LABEL_KEY}=${ctx.config.deploymentId}`,
];
const baseHostPort = (ctx: DockerCtx): number => dockerBasePort(ctx.config);
const publicHostPort = (ctx: DockerCtx): number => baseHostPort(ctx) + 1;

function hostPorts(ctx: DockerCtx, service: ServiceName): Array<[number, number]> {
  const def = serviceDef(service);
  return [
    ...(def.docker.hostPortOffset === undefined
      ? []
      : [[baseHostPort(ctx) + def.docker.hostPortOffset, def.docker.internalPort] as [number, number]]),
    ...(service === "edge" && hostsWebEdge(ctx.config.services)
      ? [[publicHostPort(ctx), PUBLIC_PORT] as [number, number]]
      : []),
  ];
}

interface DockerCtx {
  config: QmConfig;
  configDir: string;
  sandboxDir: string;
  network: string;
  prefix: string;
  databaseOwnerUrl: string;
  signingSecret?: string;
  envFile?: string;
  sandboxEnv: Record<string, string>;
  buildFrom: boolean;
  repoRoot?: string;
}

const dockerPrefix = (config: QmConfig): string => `qm-${safe(config.deploymentId)}`;
const cname = (ctx: DockerCtx, name: string): string => `${ctx.prefix}-${name}`;
const pgVolume = (ctx: DockerCtx): string => `${ctx.prefix}-pgdata`;

const localSandboxImage = (config: QmConfig): string =>
  config.sandbox?.image ?? `${dockerPrefix(config).toLowerCase()}-sandbox-local:latest`;

function localAgentSource(): Buffer {
  const source = new URL("../../templates/aws/microvm-agent/agent.mjs", import.meta.url);
  const packaged = new URL("../../../templates/aws/microvm-agent/agent.mjs", import.meta.url);
  return readFileSync(existsSync(source) ? source : packaged);
}

function ensureLocalSandboxImage(config: QmConfig): string {
  const image = localSandboxImage(config);
  if (config.sandbox?.image) return image;
  const base = sandboxBaseRef();
  try {
    const labeled = capture("docker", [
      "image",
      "inspect",
      "-f",
      '{{index .Config.Labels "qm.local-sandbox-base"}}',
      image,
    ]).trim();
    if (labeled === base) return image;
  } catch {
    // Build the local wrapper when it is absent or stale.
  }
  const dir = mkdtempSync(join(tmpdir(), "qm-local-sandbox-"));
  try {
    writeFileSync(join(dir, "agent.mjs"), localAgentSource());
    writeFileSync(
      join(dir, "Dockerfile"),
      `ARG BASE\nFROM \${BASE}\nCOPY agent.mjs /opt/qm/agent.mjs\nENV HOME=/root\nWORKDIR /root\nEXPOSE 8080\nCMD ["node", "/opt/qm/agent.mjs"]\n`,
    );
    dockerInherit([
      "build",
      "--build-arg",
      `BASE=${base}`,
      "--label",
      `qm.local-sandbox-base=${base}`,
      "-t",
      image,
      dir,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return image;
}

export function hostDockerSocket(): { path: string; gid?: string } {
  const configured = process.env.DOCKER_HOST?.trim();
  if (configured && !configured.startsWith("unix://")) {
    throw new CliError('sandbox.backend "local" requires a Unix Docker socket');
  }
  const path = configured?.slice("unix://".length) || "/var/run/docker.sock";
  let gid: string | undefined;
  try {
    gid = String(statSync(path).gid);
  } catch {
    throw new CliError(`sandbox.backend "local" cannot read the Docker socket at ${path}`);
  }
  return { path, ...(gid ? { gid } : {}) };
}

function requireDocker(): void {
  if (!which("docker")) die("docker not found on PATH (the docker target needs a running Docker daemon).");
  try {
    capture("docker", ["version", "-f", "{{.Server.Version}}"]);
  } catch {
    die("the Docker daemon is not reachable — start Docker (or OrbStack) and retry.");
  }
}

function docker(args: string[], allow?: RegExp): string {
  try {
    return capture("docker", args, allow ? { allow } : {});
  } catch (e) {
    throw dockerError(args, errMessage(e));
  }
}

function dockerInherit(args: string[], hint?: string): void {
  try {
    runInherit("docker", args);
  } catch {
    throw new CliError(`docker ${args.slice(0, 2).join(" ")} failed.${hint ? `\n${hint}` : ""}`);
  }
}

function dockerError(args: string[], message: string): CliError {
  let hint = "";
  if (/port is already allocated|address already in use/i.test(message)) {
    hint = `\nhint: a host port is already in use — set QM_BASE_PORT to a free base port.`;
  }
  return new CliError(`docker ${args.slice(0, 3).join(" ")}… failed:\n${message}${hint}`);
}

function containerRunning(name: string): boolean {
  try {
    return docker(["inspect", "-f", "{{.State.Running}}", name], /No such object/).trim() === "true";
  } catch {
    return false;
  }
}

function inspectExists(args: string[], notFound: RegExp): boolean {
  const out = docker(args, notFound);
  return out.trim().length > 0 && !notFound.test(out);
}

function containerExists(name: string): boolean {
  return inspectExists(["inspect", "-f", "{{.Id}}", name], /No such object|No such container/i);
}

function volumeExists(name: string): boolean {
  return inspectExists(["volume", "inspect", "-f", "{{.Name}}", name], /No such volume|not found/i);
}

function imageRef(ctx: DockerCtx, service: ImageName): string {
  return ctx.config.imageOverrides[service] ?? manifestRef(service);
}

function resolveImage(ctx: DockerCtx, service: ImageName, resolved: Map<ImageName, string>): string {
  const cached = resolved.get(service);
  if (cached) return cached;
  const ref = buildOrPullImage(ctx, service);
  resolved.set(service, ref);
  return ref;
}

function buildOrPullImage(ctx: DockerCtx, service: ImageName): string {
  if (ctx.buildFrom) {
    const root = ctx.repoRoot!;
    const dockerfile = join(root, "deploy", service, "Dockerfile");
    if (!existsSync(dockerfile)) throw new CliError(`no Dockerfile at ${dockerfile}`);
    const tag = `${ctx.prefix}-${service}:local`;
    const buildArgs: string[] = [];
    step(`building ${service} from ${dockerfile}`);
    dockerInherit(["build", "-f", dockerfile, "-t", tag, ...buildArgs, root]);
    return tag;
  }
  const ref = imageRef(ctx, service);
  step(`pulling ${ref}`);
  dockerInherit(
    ["pull", ref],
    `failed to pull ${ref} — the portable images may not be published yet; ` +
      `re-run with --build-from to build locally from deploy/${service}/Dockerfile.`,
  );
  return ref;
}

function resolvePluginImage(ctx: DockerCtx, p: ResolvedPlugin): string {
  if (p.kind === "source") {
    const tag = `${ctx.prefix}-${p.name}:local`;
    step(`building plugin ${p.name} from ${p.dockerfile}`);
    dockerInherit(["build", "-f", p.dockerfile!, "-t", tag, p.sourceDir!]);
    return tag;
  }
  step(`pulling plugin ${p.name} (${p.image})`);
  dockerInherit(["pull", p.image!], `failed to pull ${p.image} for plugin ${p.name}.`);
  return p.image!;
}

function ensureNetwork(ctx: DockerCtx): void {
  docker(["network", "create", ctx.network], /already exists/);
}

function persistRestart(name: string): void {
  docker(["update", "--restart", "unless-stopped", name]);
}

async function ensurePostgres(ctx: DockerCtx, dryRun: boolean): Promise<string> {
  const fromEnv = externalDockerOwnerUrl(ctx.envFile);
  if (fromEnv) {
    step("Postgres: using DATABASE_OWNER_URL from the environment");
    return fromEnv;
  }

  const pgName = cname(ctx, "pg");
  const url = (password: string): string => managedDockerOwnerUrl(password);

  if (dryRun) {
    step(`Postgres: would run ${pgName} (image pgvector/pgvector:0.8.1-pg16, volume ${pgVolume(ctx)})`);
    return url(readDeploymentState(ctx.config.deploymentId)?.pgPassword ?? "<generated>");
  }
  return withDeploymentLock(join(deploymentDir(ctx.config.deploymentId), "up.lock"), async () => {
    const state = readDeploymentState(ctx.config.deploymentId);
    let password: string;
    const existing = pgContainerPassword(pgName);
    if (existing) {
      password = existing;
    } else if (volumeExists(pgVolume(ctx))) {
      if (!state?.pgPassword) {
        throw new CliError(
          `Postgres volume ${pgVolume(ctx)} exists but its password is unknown (deployment state missing). ` +
            `Set DATABASE_OWNER_URL to point at it, or 'qm down --purge' to recreate it (DESTROYS data).`,
        );
      }
      password = state.pgPassword;
    } else {
      password = state?.pgPassword ?? randomBytes(16).toString("hex");
    }

    const stateOut: DeploymentState = {
      deploymentId: ctx.config.deploymentId,
      network: ctx.network,
      pgPassword: password,
    };
    writeDeploymentState(stateOut);

    if (!containerRunning(pgName)) {
      step(`Postgres: starting ${pgName}`);
      docker(["rm", "-f", pgName], /No such container|is not running/);
      const secretFile = writeSecretEnvFile({ POSTGRES_PASSWORD: password });
      try {
        docker([
          "run",
          "-d",
          "--name",
          pgName,
          ...deploymentLabelArgs(ctx),
          "--network",
          ctx.network,
          "--network-alias",
          "pg",
          "--restart",
          "no",
          "--env-file",
          secretFile.path,
          "-e",
          "POSTGRES_DB=qm",
          "-v",
          `${pgVolume(ctx)}:/var/lib/postgresql/data`,
          "pgvector/pgvector:0.8.1-pg16",
        ]);
      } finally {
        secretFile.cleanup();
      }
    }
    return url(password);
  });
}

async function waitPostgres(ctx: DockerCtx): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      docker(["exec", cname(ctx, "pg"), "pg_isready", "-U", "postgres"]);
      persistRestart(cname(ctx, "pg"));
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new CliError("Postgres did not become ready in 60s");
}

function readEnvValue(envFile: string | undefined, key: string): string | undefined {
  if (!envFile) return undefined;
  return readEnvFile(envFile).get(key);
}

function secretValues(ctx: DockerCtx, service: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const secret of secretsForService(ctx.config, service)) {
    if (secret.managedBy === "terraform" && isCoreWorkload(service)) continue;
    const fileValue = readEnvValue(ctx.envFile, secret.name);
    const value = deploymentSecretValue(secret.name, fileValue);
    if (value === undefined) continue;
    for (const name of runtimeSecretNames(service, secret)) out[name] = value;
  }
  return out;
}

export function dockerServiceEnv(config: QmConfig, service: ServiceName): Record<string, string> {
  if (isCoreWorkload(service)) {
    return {
      ...coreWorkloadEnv(config, service),
      ...(localSandboxActive(config)
        ? { DOCKER_HOST: "unix:///var/run/docker.sock", QM_CORE_CONTAINER: `${dockerPrefix(config)}-${service}` }
        : {}),
    };
  }
  const def = serviceDef(service);
  return {
    [def.docker.portEnv]: String(def.docker.internalPort),
    CORE_API_URL: "http://core:8080",
  };
}

function serviceEnv(ctx: DockerCtx, service: ServiceName): Record<string, string> {
  const { config } = ctx;
  const out: Record<string, string> = {};
  if (ctx.signingSecret) out.CORE_SIGNING_SECRET = ctx.signingSecret;
  Object.assign(out, dockerServiceEnv(config, service));
  const core = isCoreWorkload(service);
  if (core) {
    out.PORT = "8080";
    out.DATA_DIR = "/data";
    const layerSubs = existingLayerSubdirs(ctx);
    if (layerSubs.length) out.DEPLOYMENT_LAYER = "/layer";
    Object.assign(out, ctx.sandboxEnv);
  }
  const env = {
    ...out,
    ...hostedServiceEnv(config.services, config.env, service),
    ...secretValues(ctx, service),
  };
  if (ctx.signingSecret) env.CORE_SIGNING_SECRET = ctx.signingSecret;
  if (core) {
    Object.assign(env, databaseLoginEnv(ctx.databaseOwnerUrl));
  }
  return withoutTenantSettings(env);
}

function secretEnvKeys(ctx: DockerCtx, service: string): Set<string> {
  const keys = new Set(Object.keys(secretValues(ctx, service)));
  const plugin = ctx.config.plugins.find((entry) => entry.name === service);
  if (ctx.signingSecret && plugin?.coreAccess !== false) keys.add("CORE_SIGNING_SECRET");
  if (isCoreWorkload(service)) {
    for (const key of DATABASE_LOGIN_ENV_NAMES) keys.add(key);
  }
  return keys;
}

function writeSecretEnvFile(entries: Record<string, string>): { path: string; cleanup: () => void } {
  for (const [key, value] of Object.entries(entries)) {
    if (/[\r\n]/.test(value)) {
      throw new CliError(
        `secret ${key} contains a newline — docker --env-file is line-based and cannot carry it. ` +
          `Provide a single-line value (e.g. base64-encode PEM keys and decode in the consumer).`,
      );
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "qm-env-"));
  const path = join(dir, "secrets.env");
  writeFileSync(
    path,
    `${Object.entries(entries)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function pushEnvArgs(args: string[], env: Record<string, string>, secretKeys: Set<string>): () => void {
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (secretKeys.has(k)) secrets[k] = v;
    else args.push("-e", `${k}=${v}`);
  }
  if (!Object.keys(secrets).length) return () => {};
  const file = writeSecretEnvFile(secrets);
  args.push("--env-file", file.path);
  return file.cleanup;
}

function runArgs(ctx: DockerCtx, service: ServiceName, image: string): { args: string[]; cleanup: () => void } {
  const def = serviceDef(service);
  const args = [
    "run",
    "-d",
    "--name",
    cname(ctx, service),
    ...deploymentLabelArgs(ctx),
    "--network",
    ctx.network,
    "--network-alias",
    service,
    ...(service === "edge" ? ["--network-alias", "core"] : []),
    "--network-alias",
    `${cname(ctx, service)}.internal`,
    "--restart",
    "no",
  ];
  const cleanup = pushEnvArgs(args, serviceEnv(ctx, service), secretEnvKeys(ctx, service));
  if (isCoreWorkload(service)) {
    args.push("-v", `${ctx.prefix}-coredata:/data`);
    for (const m of layerMounts(ctx)) args.push("-v", m);
    for (const m of skillMounts(ctx)) args.push("-v", m);
    if (localSandboxActive(ctx.config)) {
      const socket = hostDockerSocket();
      args.push("-v", `${socket.path}:/var/run/docker.sock`);
      if (socket.gid) args.push("--group-add", socket.gid);
    }
  }
  for (const [host, container] of hostPorts(ctx, service)) args.push("-p", `${host}:${container}`);
  args.push(image, ...(def.command ?? []));
  return { args, cleanup };
}

function skillMounts(ctx: DockerCtx): string[] {
  return ctx.config.skills.map((s, i) => `${resolve(ctx.configDir, s)}:/app/plugins/deployment-skills-${i}/skills:ro`);
}

function existingLayerSubdirs(ctx: DockerCtx): Array<"skills" | "tools"> {
  return (["skills", "tools"] as const).filter((s) => existsSync(join(ctx.sandboxDir, s)));
}

function layerMounts(ctx: DockerCtx): string[] {
  return existingLayerSubdirs(ctx).map((sub) => `${join(ctx.sandboxDir, sub)}:/layer/${sub}:ro`);
}

function noteLogTail(name: string, logs: string): void {
  note(`--- ${name} logs (tail) ---`);
  note(tailString(logs, 25));
}

async function waitReady(ctx: DockerCtx, service: ServiceName): Promise<void> {
  const def = serviceDef(service);
  const name = cname(ctx, service);
  for (let i = 0; i < 90; i++) {
    const logs = captureBoth("docker", ["logs", name]);
    if (def.readiness.test(logs)) {
      persistRestart(name);
      return;
    }
    if (!containerRunning(name)) {
      noteLogTail(name, logs);
      throw new CliError(`${service} exited before becoming ready (see logs above)`);
    }
    await sleep(1000);
  }
  throw new CliError(`${service} did not become ready in 90s`);
}

async function waitPluginUp(name: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    if (!containerRunning(name)) {
      noteLogTail(name, captureBoth("docker", ["logs", name]));
      throw new CliError(`plugin ${name} exited on boot (see logs above) — check the image and its env`);
    }
  }
  persistRestart(name);
}

function buildCtx(
  config: QmConfig,
  configDir: string,
  opts: {
    sandboxDir?: string;
    buildFrom: boolean;
    buildFromPath?: string;
    envFile?: string;
    localSandboxImage?: string;
  },
): DockerCtx {
  const prefix = dockerPrefix(config);
  const envFile = opts.envFile ? resolve(opts.envFile) : join(configDir, ".env");
  if (opts.envFile && !existsSync(envFile)) throw new CliError(`--env-file not found: ${opts.envFile}`);
  const ctx: DockerCtx = {
    config,
    configDir,
    sandboxDir: resolve(opts.sandboxDir ?? join(configDir, "sandbox")),
    network: prefix,
    prefix,
    databaseOwnerUrl: "",
    sandboxEnv: {},
    buildFrom: opts.buildFrom,
  };
  if (existsSync(envFile)) ctx.envFile = envFile;
  const signingSecret = deploymentSecretValue("CORE_SIGNING_SECRET", readEnvValue(ctx.envFile, "CORE_SIGNING_SECRET"));
  if (signingSecret) ctx.signingSecret = signingSecret;
  const sb = sandboxCoreEnv(config);
  ctx.sandboxEnv = {
    ...sb.env,
    ...(opts.localSandboxImage ? { LOCAL_SANDBOX_IMAGE: opts.localSandboxImage } : {}),
  };
  if (opts.buildFrom) ctx.repoRoot = resolveBuildRepoRoot(opts.buildFromPath, runnableImages(config.services));
  return ctx;
}

function warnUnforwardedEnvKeys(ctx: DockerCtx): void {
  if (!ctx.envFile) return;
  const injected = new Set(computedSecrets(ctx.config).map((secret) => secret.name));
  injected.add("CORE_SIGNING_SECRET");
  injected.add("DATABASE_OWNER_URL");
  const dropped = [...readEnvFile(ctx.envFile).keys()].filter((key) => !injected.has(key));
  if (!dropped.length) return;
  warn(
    `.env keys not forwarded to any container: ${dropped.join(", ")} — only computed secret names are ` +
      `injected. Move non-secret settings to "env.<service>" in the QM deployment config.`,
  );
}

function missingRequiredOperatorSecrets(config: QmConfig, values: ReadonlyMap<string, string>): string[] {
  return missingRequiredSecrets(
    computedSecrets(config).filter((secret) => secret.managedBy === "operator"),
    (name) => deploymentSecretValue(name, values.get(name)),
  );
}

export async function dockerDoctor(config: QmConfig, configDir: string, envFile?: string): Promise<void> {
  const values = localDoctorSecrets(configDir, envFile);
  const missing = missingRequiredOperatorSecrets(config, values);
  if (missing.length) throw new CliError(`required secrets are missing or placeholders: ${missing.join(", ")}`);
  step("required operator secret values: ok");
  await doctorCommon(config, values, { configDir });
}

export async function dockerUp(
  config: QmConfig,
  configDir: string,
  opts: { sandboxDir?: string; buildFrom?: boolean; buildFromPath?: string; envFile?: string; dryRun?: boolean } = {},
): Promise<void> {
  if (!opts.dryRun) requireDocker();
  const resolvedLocalImage = localSandboxActive(config) ? localSandboxImage(config) : undefined;
  const ctx = buildCtx(config, configDir, {
    sandboxDir: opts.sandboxDir,
    buildFrom: opts.buildFrom ?? false,
    buildFromPath: opts.buildFromPath,
    envFile: opts.envFile,
    ...(resolvedLocalImage ? { localSandboxImage: resolvedLocalImage } : {}),
  });
  const plugins = discoverPlugins(configDir, config).plugins;

  header(`qm up — ${config.deploymentId} (target: docker${opts.buildFrom ? ", build-from-source" : ""})`);
  if (opts.dryRun) note(bold("DRY RUN — no containers will be started.\n"));
  warnUnforwardedEnvKeys(ctx);
  const missingRequired = missingRequiredOperatorSecrets(
    ctx.config,
    ctx.envFile ? readEnvFile(ctx.envFile) : new Map(),
  );
  if (opts.dryRun && missingRequired.length) {
    warn(`MISSING required secrets — add them to .env before up: ${missingRequired.join(", ")}`);
  }

  if (opts.dryRun) {
    ctx.databaseOwnerUrl = await ensurePostgres(ctx, true);
    step(`network: ${ctx.network}`);
    if (resolvedLocalImage) step(`sandbox: local image ${resolvedLocalImage}`);
    for (const def of ordered(runnableServices(config.services))) {
      const mapped = hostPorts(ctx, def.name).map(([host]) => `:${host}`);
      const ports = mapped.length ? ` (host ${mapped.join(", ")})` : "";
      const image = def.docker.image;
      step(`${def.name}: image ${ctx.buildFrom ? `build deploy/${image}/Dockerfile` : imageRef(ctx, image)}${ports}`);
      note(`     env: ${Object.keys(serviceEnv(ctx, def.name)).join(", ") || "(none)"}`);
      if (def.name === "edge") {
        const subs = existingLayerSubdirs(ctx);
        note(
          `     layer: ${subs.length ? `${ctx.sandboxDir} → /layer (${subs.join(", ")})` : `(no skills/ or tools/ in ${ctx.sandboxDir})`}`,
        );
      }
    }
    for (const p of plugins) {
      step(
        p.kind === "image"
          ? `plugin ${p.name}: pull ${p.image}`
          : `plugin ${p.name}: build plugins/${p.name}/Dockerfile`,
      );
    }
    note("\n" + bold("Plan only. Re-run without --dry-run to apply."));
    return;
  }

  if (missingRequired.length) {
    throw new CliError(
      `required secrets have no value in ./.env or the environment: ${missingRequired.join(", ")}\n` +
        `Add them to .env (see .env.example; generate signing secrets with: openssl rand -hex 32).`,
    );
  }

  if (localSandboxActive(config)) ensureLocalSandboxImage(config);
  ensureNetwork(ctx);
  ctx.databaseOwnerUrl = await ensurePostgres(ctx, false);
  if (!externalDockerOwnerUrl(ctx.envFile)) {
    await waitPostgres(ctx);
    bootstrapDockerOwner(cname(ctx, "pg"), readDeploymentState(config.deploymentId)!.pgPassword!);
  }

  const images = new Map<ImageName, string>();
  removeRetiredContainers(ctx);
  for (const def of ordered(runnableServices(config.services))) {
    const image = resolveImage(ctx, def.docker.image, images);
    docker(["rm", "-f", cname(ctx, def.name)], /No such container|is not running/);
    step(`starting ${def.name}`);
    const run = runArgs(ctx, def.name, image);
    try {
      docker(run.args);
    } finally {
      run.cleanup();
    }
    await waitReady(ctx, def.name);
    ok(`${def.name} ready`);
  }

  for (const p of plugins) {
    const image = resolvePluginImage(ctx, p);
    docker(["rm", "-f", cname(ctx, p.name)], /No such container|is not running/);
    step(`starting plugin ${p.name} (${image})`);
    const args = [
      "run",
      "-d",
      "--name",
      cname(ctx, p.name),
      ...deploymentLabelArgs(ctx),
      "--network",
      ctx.network,
      "--network-alias",
      p.name,
      "--restart",
      "no",
    ];
    const wiring = {
      ...(p.coreAccess === false ? {} : { CORE_API_URL: "http://core:8080" }),
      PORT: "8080",
    };
    const env = {
      ...wiring,
      ...p.env,
      ...(ctx.signingSecret && p.coreAccess !== false ? { CORE_SIGNING_SECRET: ctx.signingSecret } : {}),
      ...secretValues(ctx, p.name),
    };
    const cleanup = pushEnvArgs(args, env, secretEnvKeys(ctx, p.name));
    args.push(image);
    try {
      docker(args);
    } finally {
      cleanup();
    }
    await waitPluginUp(cname(ctx, p.name));
    ok(`plugin ${p.name} running`);
  }

  printUrls(ctx);
}

function printUrls(ctx: DockerCtx): void {
  note("");
  ok(`stack up — ${ctx.config.deploymentId}`);
  if (hostsWebEdge(ctx.config.services))
    note(`   web    : http://localhost:${publicHostPort(ctx)}  (public front door)`);
  note(`   api    : http://localhost:${baseHostPort(ctx)}`);
  note(`   status : qm status   ·   logs: qm logs edge | harness   ·   stop: qm down`);
}

export function dockerStatus(config: QmConfig): void {
  requireDocker();
  header(`qm status — ${config.deploymentId}`);
  dockerInherit([
    "ps",
    "-a",
    "--filter",
    `label=${DEPLOYMENT_LABEL_KEY}=${config.deploymentId}`,
    "--format",
    "table {{.Names}}\t{{.Status}}\t{{.Ports}}",
  ]);
  const hosted = config.services.filter(isVirtualService);
  if (hosted.length) note(`${hosted.join(", ")}: running in the edge container`);
}

const RETIRED_CONTAINERS = ["core", "web-ui", "portal", "auth", "admin"];

function removeRetiredContainers(ctx: DockerCtx): void {
  const present = new Set(psNames(["-a"]));
  for (const name of RETIRED_CONTAINERS.map((service) => cname(ctx, service))) {
    if (!present.has(name)) continue;
    step(`removing ${name} (now served by edge and harness)`);
    docker(["rm", "-f", name], /No such container/);
  }
}

function psNames(args: string[]): string[] {
  return docker(["ps", ...args, "--format", "{{.Names}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function listDeploymentContainers(deploymentId: string): string[] {
  return psNames(["-a", "--filter", `label=${DEPLOYMENT_LABEL_KEY}=${deploymentId}`]);
}

export async function dockerLogs(config: QmConfig, service: string | undefined, opts: LogOpts = {}): Promise<void> {
  requireDocker();
  const prefix = dockerPrefix(config);
  const tail = String(opts.tail ?? 200);

  if (service) {
    const resolved = serviceWorkloads(service);
    if (resolved.join() !== service) note(`${service} runs in ${resolved.join(" and ")}; showing its logs`);
    const names = resolved.map((workload) => `${prefix}-${workload}`);
    const missing = names.find((name) => !containerExists(name));
    if (missing) die(`no container ${missing} (is the stack up? services: ${config.services.join(", ")})`);
    if (names.length > 1) {
      await streamPrefixedLogs(names, prefix, { follow: opts.follow ?? false, tail });
      return;
    }
    const args = ["logs", "--tail", tail];
    if (opts.follow) args.push("-f");
    args.push(names[0]!);
    dockerInherit(args);
    return;
  }

  const names = listDeploymentContainers(config.deploymentId);
  if (names.length === 0) die(`no containers for ${config.deploymentId} (is the stack up? run \`qm up\`)`);
  await streamPrefixedLogs(names, prefix, { follow: opts.follow ?? false, tail });
}

function streamPrefixedLogs(names: string[], prefix: string, opts: { follow: boolean; tail: string }): Promise<void> {
  return streamLabeled(
    names.map((name) => ({
      label: name.slice(prefix.length + 1),
      command: "docker",
      args: ["logs", "--tail", opts.tail, ...(opts.follow ? ["-f"] : []), name],
    })),
    (label, line) => note(`${dim(label)} | ${line}`),
  );
}

export async function dockerDown(config: QmConfig, opts: { purge?: boolean } = {}): Promise<void> {
  requireDocker();
  const prefix = dockerPrefix(config);
  header(`qm down — ${config.deploymentId}`);
  const serviceNames = teardownOrdered(runnableServices(config.services)).map((d) => `${prefix}-${d.name}`);
  const pgName = `${prefix}-pg`;
  const known = new Set([...serviceNames, pgName]);
  const pluginNames = [
    ...new Set([
      ...config.plugins.map((p) => `${prefix}-${p.name}`),
      ...listDeploymentContainers(config.deploymentId).filter((n) => !known.has(n)),
    ]),
  ];
  const candidates = [...pluginNames, ...serviceNames, pgName];
  const present = new Set(psNames(["-a"]));
  for (const name of candidates) {
    if (!present.has(name)) continue;
    step(`removing ${name}`);
    docker(["rm", "-f", name], /No such container/);
  }
  if (opts.purge) {
    warn("purging the network and Postgres volume (durable data will be lost)");
    docker(["network", "rm", prefix], /not found|No such/);
    docker(["volume", "rm", `${prefix}-pgdata`, `${prefix}-coredata`], /No such volume|not found|in use/);
  }
  ok("down.");
}
