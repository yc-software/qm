import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isIP } from "node:net";
import { CliError, bold, die, dim, errMessage, header, note, ok, step, warn } from "../log.ts";
import {
  capture,
  captureBoth,
  deploymentSecretValue,
  isInvalidSecret,
  readEnvFile,
  resolveBuildRepoRoot,
  runInherit,
  sleep,
  streamLabeled,
  tailString,
  which,
} from "../util.ts";
import { manifestRef } from "../manifest.ts";
import {
  brokerWiring,
  ordered,
  orgEnv,
  runnableServices,
  serviceDef,
  teardownOrdered,
  virtualServiceEnv,
  type LogOpts,
  type ServiceName,
} from "../services.ts";
import { dockerBasePort, sandboxCoreEnv, securityScreenEnv, type QmConfig } from "../config.ts";
import { discoverPlugins, type ResolvedPlugin } from "../plugins.ts";
import { computedSecrets, runtimeSecretNames, secretsForService } from "../secrets.ts";
import { readDeploymentState, withDeploymentLock, writeDeploymentState, type DeploymentState } from "../state.ts";

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "-");
const ORG_LABEL_KEY = "qm.org";
const orgLabelArgs = (ctx: DockerCtx): string[] => ["--label", `${ORG_LABEL_KEY}=${ctx.config.orgId}`];
const baseHostPort = (ctx: DockerCtx): number => dockerBasePort(ctx.config);

interface DockerCtx {
  config: QmConfig;
  configDir: string;
  sandboxDir: string;
  network: string;
  prefix: string;
  databaseUrl: string;
  signingSecret?: string;
  envFile?: string;
  sandboxEnv: Record<string, string>;
  sandboxSecretKeys: Set<string>;
  missingSandboxSecrets: string[];
  buildFrom: boolean;
  repoRoot?: string;
  dockerSocketPath?: string;
}

const dockerPrefix = (config: QmConfig): string => `qm-${safe(config.orgId)}`;
const cname = (ctx: DockerCtx, name: string): string => `${ctx.prefix}-${name}`;
const pgVolume = (ctx: DockerCtx): string => `${ctx.prefix}-pgdata`;

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

function ensureVolume(ctx: DockerCtx, name: string): void {
  if (!volumeExists(name)) docker(["volume", "create", ...orgLabelArgs(ctx), name]);
}

function pgContainerPassword(ctx: DockerCtx): string | undefined {
  if (!containerExists(cname(ctx, "pg"))) return undefined;
  try {
    const env = docker(["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", cname(ctx, "pg")]);
    return env
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("POSTGRES_PASSWORD="))
      ?.slice("POSTGRES_PASSWORD=".length);
  } catch {
    return undefined;
  }
}

function imageRef(ctx: DockerCtx, service: ServiceName): string {
  return ctx.config.imageOverrides[service] ?? manifestRef(service);
}

function resolveImage(ctx: DockerCtx, service: ServiceName): string {
  if (ctx.buildFrom) {
    const root = ctx.repoRoot!;
    const dockerfile = join(root, "deploy", service, "Dockerfile");
    if (!existsSync(dockerfile)) throw new CliError(`no Dockerfile at ${dockerfile}`);
    const tag = `qm-${service}:local`;
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
  docker(["network", "create", ...orgLabelArgs(ctx), ctx.network], /already exists/);
}

function effectiveDockerSocket(): string {
  const context = process.env.DOCKER_CONTEXT?.trim();
  const endpoint = context
    ? docker(["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]).trim()
    : process.env.DOCKER_HOST?.trim() ||
      docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).trim();
  if (!endpoint.startsWith("unix://")) {
    throw new CliError(
      `the Docker target requires a local Unix socket context; active endpoint is ${endpoint || "unset"}`,
    );
  }
  const path = decodeURIComponent(new URL(endpoint).pathname);
  if (!path.startsWith("/")) throw new CliError(`the Docker target cannot resolve the active Unix socket: ${endpoint}`);
  return path;
}

function requireVolumeSubpathSupport(): void {
  const version = docker(["version", "-f", "{{.Server.Version}}"]).trim();
  const major = Number(version.match(/^(\d+)/)?.[1]);
  if (!Number.isFinite(major) || major < 26) {
    throw new CliError("Docker Engine 26 or newer is required for containerized core deployments");
  }
}

function persistRestart(name: string): void {
  docker(["update", "--restart", "unless-stopped", name]);
}

function externalDatabaseUrl(ctx: DockerCtx): string | undefined {
  return process.env.DATABASE_URL ?? readEnvValue(ctx.envFile, "DATABASE_URL");
}

function ensurePostgres(ctx: DockerCtx, dryRun: boolean): string {
  const fromEnv = externalDatabaseUrl(ctx);
  if (fromEnv) {
    step("Postgres: using DATABASE_URL from the environment");
    return fromEnv;
  }

  const pgName = cname(ctx, "pg");
  const url = (password: string): string => `postgres://postgres:${password}@pg:5432/qm`;

  if (dryRun) {
    step(`Postgres: would run ${pgName} (image postgres:16, volume ${pgVolume(ctx)})`);
    return url(readDeploymentState(ctx.config.orgId)?.pgPassword ?? "<generated>");
  }
  return withDeploymentLock(ctx.config.orgId, () => {
    const state = readDeploymentState(ctx.config.orgId);
    let password: string;
    const existing = pgContainerPassword(ctx);
    if (existing) {
      password = existing;
    } else if (volumeExists(pgVolume(ctx))) {
      if (!state?.pgPassword) {
        throw new CliError(
          `Postgres volume ${pgVolume(ctx)} exists but its password is unknown (deployment state missing). ` +
            `Set DATABASE_URL to point at it, or 'qm down --purge' to recreate it (DESTROYS data).`,
        );
      }
      password = state.pgPassword;
    } else {
      password = state?.pgPassword ?? randomBytes(16).toString("hex");
    }

    const stateOut: DeploymentState = { orgId: ctx.config.orgId, network: ctx.network, pgPassword: password };
    writeDeploymentState(stateOut);

    if (!containerRunning(pgName)) {
      step(`Postgres: starting ${pgName}`);
      ensureVolume(ctx, pgVolume(ctx));
      docker(["rm", "-f", pgName], /No such container|is not running/);
      const secretFile = writeSecretEnvFile({ POSTGRES_PASSWORD: password });
      try {
        docker([
          "run",
          "-d",
          "--name",
          pgName,
          ...orgLabelArgs(ctx),
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
          "postgres:16",
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
    if (secret.managedBy === "terraform" && service === "core") continue;
    const fileValue = readEnvValue(ctx.envFile, secret.name);
    const value = deploymentSecretValue(secret.name, fileValue);
    if (value === undefined) continue;
    for (const name of runtimeSecretNames(service, secret)) {
      if (name !== `FLY_RESIDENT_ENV_${secret.name}`) out[name] = value;
    }
  }
  return out;
}

export function dockerServiceEnv(config: QmConfig, service: ServiceName): Record<string, string> {
  const def = serviceDef(service);
  const out: Record<string, string> = {
    [def.docker.portEnv]: String(def.docker.internalPort),
    CORE_API_URL: "http://core:8080",
    ...orgEnv(service, config.orgId, config.publicUrl, config.services.includes("portal")),
  };
  if (service === "portal") {
    if (config.services.includes("web-ui")) out.WEB_UI_UPSTREAM = "http://web-ui:8080";
    if (config.services.includes("admin")) out.ADMIN_UPSTREAM = "http://admin:8080";
  }
  if (config.services.includes("auth")) {
    Object.assign(
      out,
      brokerWiring(service, {
        publicUrl: config.publicUrl,
        authBaseUrl: "http://auth:8080",
        ...(config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN
          ? { allowedEmailDomain: config.env.auth.AUTH_ALLOWED_EMAIL_DOMAIN }
          : {}),
      }),
    );
  }
  return out;
}

function serviceEnv(ctx: DockerCtx, service: ServiceName): Record<string, string> {
  const { config } = ctx;
  const out: Record<string, string> = {};
  if (ctx.signingSecret) out.CORE_SIGNING_SECRET = ctx.signingSecret;
  if (service === "core") {
    Object.assign(out, orgEnv("core", config.orgId, config.publicUrl, config.services.includes("portal")));
    out.PORT = "8080";
    out.DATA_DIR = "/data";
    out.SESSION_STORE = "postgres";
    out.RUN_STORE = "postgres";
    out.DATABASE_URL = ctx.databaseUrl;
    if (config.model) out.PI_MODEL = config.model;
    if (config.modelProvider) out.MODEL_PROVIDER = config.modelProvider;
    const layerSubs = existingLayerSubdirs(ctx);
    if (layerSubs.length) out.DEPLOYMENT_LAYER = "/layer";
    Object.assign(out, ctx.sandboxEnv);
  } else {
    Object.assign(out, dockerServiceEnv(config, service));
  }
  const virtualEnv = service === "core" ? virtualServiceEnv(config.services, config.env) : {};
  const env = {
    ...out,
    ...virtualEnv,
    ...config.env[service],
    ...(service === "core" ? securityScreenEnv(config) : {}),
    ...secretValues(ctx, service),
  };
  if (ctx.signingSecret) env.CORE_SIGNING_SECRET = ctx.signingSecret;
  if (service === "core") {
    env.DATABASE_URL = ctx.databaseUrl;
    const sandboxBackend = env.SANDBOX_BACKEND?.trim();
    const secondarySandboxBackend = env.SANDBOX_SECONDARY_BACKEND?.trim();
    const deployProvider = env.DEPLOY_PROVIDER?.trim();
    const localSandbox = sandboxBackend === "local" || secondarySandboxBackend === "local";
    const localSandboxOnly =
      sandboxBackend === "local" && (!secondarySandboxBackend || secondarySandboxBackend === "local");
    if (localSandbox || deployProvider !== "aws") {
      env.DOCKER_CORE_CONTAINER = cname(ctx, "core");
      env.DOCKER_CORE_DATA_VOLUME = `${ctx.prefix}-coredata`;
      env.DOCKER_DEPLOY_NETWORK = `${ctx.prefix}-deployments`;
      env.DATA_DIR = "/data";
    }
    if (localSandbox && !localSandboxOnly) {
      if (!env.PUBLIC_API_URL) {
        throw new CliError("mixed local and remote sandbox backends require an externally reachable PUBLIC_API_URL");
      }
      requireExternalApiUrl(env.PUBLIC_API_URL);
    } else if (localSandbox && !env.PUBLIC_API_URL) {
      env.PUBLIC_API_URL = "http://core:8080";
    }
    for (const key of ctx.sandboxSecretKeys) {
      const value = out[key];
      if (value !== undefined) env[key] = value;
      else delete env[key];
    }
  }
  return env;
}

function requireExternalApiUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError("mixed local and remote sandbox backends require PUBLIC_API_URL to be a valid HTTPS URL");
  }
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  const ipv4 = isIP(host) === 4 ? host.split(".").map(Number) : [];
  const privateIpv4 =
    ipv4.length === 4 &&
    (ipv4[0] === 0 ||
      ipv4[0] === 10 ||
      ipv4[0] === 127 ||
      (ipv4[0] === 100 && ipv4[1]! >= 64 && ipv4[1]! <= 127) ||
      (ipv4[0] === 169 && ipv4[1] === 254) ||
      (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31) ||
      (ipv4[0] === 192 && (ipv4[1] === 0 || ipv4[1] === 168)) ||
      (ipv4[0] === 198 && (ipv4[1] === 18 || ipv4[1] === 19 || (ipv4[1] === 51 && ipv4[2] === 100))) ||
      (ipv4[0] === 203 && ipv4[1] === 0 && ipv4[2] === 113) ||
      ipv4[0]! >= 224);
  const privateIpv6 =
    isIP(host) === 6 &&
    (/^::$/.test(host) ||
      /^::1$/.test(host) ||
      /^::ffff:/i.test(host) ||
      /^(fc|fd|fe8|fe9|fea|feb)/i.test(host) ||
      /^ff/i.test(host) ||
      /^2001:db8:/i.test(host));
  const reservedName =
    !isIP(host) &&
    (!host.includes(".") ||
      ["localhost", "local", "internal", "home", "lan", "test", "invalid", "example"].some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      ));
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    reservedName ||
    privateIpv4 ||
    privateIpv6
  ) {
    throw new CliError("mixed local and remote sandbox backends require an externally reachable HTTPS PUBLIC_API_URL");
  }
}

function secretEnvKeys(ctx: DockerCtx, service: string): Set<string> {
  const keys = new Set(Object.keys(secretValues(ctx, service)));
  if (ctx.signingSecret) keys.add("CORE_SIGNING_SECRET");
  if (service === "core") {
    keys.add("DATABASE_URL");
    for (const key of ctx.sandboxSecretKeys) keys.add(key);
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
    ...orgLabelArgs(ctx),
    "--network",
    ctx.network,
    "--network-alias",
    service,
    "--restart",
    "no",
  ];
  const env = serviceEnv(ctx, service);
  if (service === "core") {
    args.push("-v", `${ctx.prefix}-coredata:/data`);
    if (env.DOCKER_CORE_CONTAINER) {
      if (!ctx.dockerSocketPath) throw new CliError("the active Docker socket was not resolved");
      let socketGroup: string;
      try {
        socketGroup = docker([
          "run",
          "--rm",
          "-v",
          `${ctx.dockerSocketPath}:/var/run/docker.sock`,
          "--entrypoint",
          "stat",
          image,
          "-c",
          "%g",
          "/var/run/docker.sock",
        ]).trim();
      } catch {
        throw new CliError(
          "the core cannot mount the active Docker socket; allow this image when Docker Desktop Enhanced Container Isolation is enabled",
        );
      }
      if (!/^\d+$/.test(socketGroup)) throw new CliError(`could not resolve the Docker socket group from ${image}`);
      args.push("--group-add", socketGroup, "-v", `${ctx.dockerSocketPath}:/var/run/docker.sock`);
    }
    for (const m of layerMounts(ctx)) args.push("-v", m);
    for (const m of skillMounts(ctx)) args.push("-v", m);
  }
  if (def.docker.hostPortOffset !== undefined) {
    args.push("-p", `${baseHostPort(ctx) + def.docker.hostPortOffset}:${def.docker.internalPort}`);
  }
  const cleanup = pushEnvArgs(args, env, secretEnvKeys(ctx, service));
  args.push(image);
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
  opts: { sandboxDir?: string; buildFrom: boolean; buildFromPath?: string; envFile?: string },
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
    databaseUrl: "",
    sandboxEnv: {},
    sandboxSecretKeys: new Set((config.sandbox?.secretEnv ?? []).map((name) => `FLY_RESIDENT_ENV_${name}`)),
    missingSandboxSecrets: [],
    buildFrom: opts.buildFrom,
  };
  if (existsSync(envFile)) ctx.envFile = envFile;
  const signingSecret = deploymentSecretValue("CORE_SIGNING_SECRET", readEnvValue(ctx.envFile, "CORE_SIGNING_SECRET"));
  if (signingSecret) ctx.signingSecret = signingSecret;
  const lookup = (name: string): string | undefined => deploymentSecretValue(name, readEnvValue(ctx.envFile, name));
  const sb = sandboxCoreEnv(config, lookup);
  ctx.sandboxEnv = sb.env;
  ctx.missingSandboxSecrets = sb.missingSecrets;
  if (opts.buildFrom) ctx.repoRoot = resolveBuildRepoRoot(opts.buildFromPath, runnableServices(config.services));
  return ctx;
}

function warnUnforwardedEnvKeys(ctx: DockerCtx): void {
  if (!ctx.envFile) return;
  const injected = new Set(computedSecrets(ctx.config).map((secret) => secret.name));
  injected.add("CORE_SIGNING_SECRET");
  injected.add("DATABASE_URL");
  const dropped = [...readEnvFile(ctx.envFile).keys()].filter((key) => !injected.has(key));
  if (!dropped.length) return;
  warn(
    `.env keys not forwarded to any container: ${dropped.join(", ")} — only computed secret names are ` +
      `injected. Move non-secret settings to "env.<service>" in the QM deployment config.`,
  );
}

function missingRequiredOperatorSecrets(ctx: DockerCtx): string[] {
  const lookup = (name: string): string | undefined => deploymentSecretValue(name, readEnvValue(ctx.envFile, name));
  return computedSecrets(ctx.config)
    .filter(
      (secret) =>
        secret.required && secret.managedBy === "operator" && isInvalidSecret(secret.name, lookup(secret.name)),
    )
    .map((secret) => secret.name);
}

export async function dockerUp(
  config: QmConfig,
  configDir: string,
  opts: { sandboxDir?: string; buildFrom?: boolean; buildFromPath?: string; envFile?: string; dryRun?: boolean } = {},
): Promise<void> {
  if (!opts.dryRun) requireDocker();
  const ctx = buildCtx(config, configDir, {
    sandboxDir: opts.sandboxDir,
    buildFrom: opts.buildFrom ?? false,
    buildFromPath: opts.buildFromPath,
    envFile: opts.envFile,
  });
  const plugins = discoverPlugins(configDir, config).plugins;

  header(`qm up — ${config.orgId} (target: docker${opts.buildFrom ? ", build-from-source" : ""})`);
  if (opts.dryRun) note(bold("DRY RUN — no containers will be started.\n"));
  warnUnforwardedEnvKeys(ctx);
  for (const name of ctx.missingSandboxSecrets) {
    warn(`sandbox.secretEnv "${name}" has no value in .env or the environment — it won't be set in the sandbox.`);
  }
  const missingRequired = missingRequiredOperatorSecrets(ctx);
  if (opts.dryRun && missingRequired.length) {
    warn(`MISSING required secrets — add them to .env before up: ${missingRequired.join(", ")}`);
  }

  if (opts.dryRun) {
    ctx.databaseUrl = ensurePostgres(ctx, true);
    step(`network: ${ctx.network}`);
    for (const def of ordered(runnableServices(config.services))) {
      const ports =
        def.docker.hostPortOffset !== undefined ? ` (host :${baseHostPort(ctx) + def.docker.hostPortOffset})` : "";
      step(
        `${def.name}: image ${ctx.buildFrom ? `build deploy/${def.name}/Dockerfile` : imageRef(ctx, def.name)}${ports}`,
      );
      note(`     env: ${Object.keys(serviceEnv(ctx, def.name)).join(", ") || "(none)"}`);
      if (def.name === "core") {
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

  const coreEnv = serviceEnv(ctx, "core");
  if (coreEnv.DOCKER_CORE_CONTAINER) ctx.dockerSocketPath = effectiveDockerSocket();
  if (coreEnv.DEPLOY_PROVIDER?.trim() !== "aws") requireVolumeSubpathSupport();
  ensureNetwork(ctx);
  ensureVolume(ctx, `${ctx.prefix}-coredata`);
  ctx.databaseUrl = ensurePostgres(ctx, false);
  if (!externalDatabaseUrl(ctx)) await waitPostgres(ctx);

  for (const def of ordered(runnableServices(config.services))) {
    const image = resolveImage(ctx, def.name);
    const run = runArgs(ctx, def.name, image);
    try {
      docker(["rm", "-f", cname(ctx, def.name)], /No such container|is not running/);
      step(`starting ${def.name}`);
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
      ...orgLabelArgs(ctx),
      "--network",
      ctx.network,
      "--network-alias",
      p.name,
      "--restart",
      "no",
    ];
    const wiring = {
      CORE_API_URL: "http://core:8080",
      ...orgEnv(p.name, config.orgId, config.publicUrl, config.services.includes("portal")),
      PORT: "8080",
    };
    const env = {
      ...wiring,
      ...p.env,
      ...(ctx.signingSecret ? { CORE_SIGNING_SECRET: ctx.signingSecret } : {}),
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
  ok(`stack up — ${ctx.config.orgId}`);
  const has = (s: ServiceName): boolean => ctx.config.services.includes(s);
  const url = (s: ServiceName): string =>
    `http://localhost:${baseHostPort(ctx) + serviceDef(s).docker.hostPortOffset!}`;
  if (has("portal")) note(`   portal : ${url("portal")}  (public front door)`);
  if (has("auth"))
    note(`   auth   : ${url("portal")}/idp/authorize  (sign-in broker, published only through the portal)`);
  if (has("web-ui")) note(`   web-ui : ${url("web-ui")}`);
  if (has("admin")) note(`   admin  : ${url("admin")}/admin`);
  note(`   core   : ${url("core")}`);
  note(`   status : qm status   ·   logs: qm logs core   ·   stop: qm down`);
}

export function dockerStatus(config: QmConfig): void {
  requireDocker();
  header(`qm status — ${config.orgId}`);
  dockerInherit([
    "ps",
    "-a",
    "--filter",
    `label=${ORG_LABEL_KEY}=${config.orgId}`,
    "--format",
    "table {{.Names}}\t{{.Status}}\t{{.Ports}}",
  ]);
  if (config.services.includes("slack")) note("slack: virtual service running in the core container");
}

function psNames(args: string[]): string[] {
  return docker(["ps", ...args, "--format", "{{.Names}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function listDeploymentContainers(orgId: string): string[] {
  return psNames(["-a", "--filter", `label=${ORG_LABEL_KEY}=${orgId}`]);
}

function listMigrationOwnerContainers(orgId: string): string[] {
  return psNames(["-a", "--filter", `label=qm.volume-org=${orgId}`]);
}

function listDeploymentNetworks(orgId: string): string[] {
  return docker(["network", "ls", "--filter", `label=${ORG_LABEL_KEY}=${orgId}`, "--format", "{{.Name}}"])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

function listDeploymentVolumes(orgId: string): string[] {
  return docker(["volume", "ls", "--filter", `label=${ORG_LABEL_KEY}=${orgId}`, "--format", "{{.Name}}"])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

function legacySandboxResources(name: string): { networks: string[]; volumes: string[] } | null {
  if (docker(["inspect", "-f", '{{index .Config.Labels "qm.sandbox"}}', name]).trim() !== "1") return null;
  const volumes = docker([
    "inspect",
    "-f",
    '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}',
    name,
  ])
    .split("\n")
    .map((volume) => volume.trim())
    .filter((volume) => volume.startsWith("qm-home-"))
    .filter(
      (volume) => docker(["volume", "inspect", "-f", `{{index .Labels "${ORG_LABEL_KEY}"}}`, volume]).trim() === "",
    );
  const networks = docker([
    "inspect",
    "-f",
    "{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}",
    name,
  ])
    .split("\n")
    .map((network) => network.trim())
    .filter((network) => network.startsWith("qm-net-"));
  if (!volumes.length && !networks.length) return null;
  return { networks, volumes };
}

export async function dockerLogs(config: QmConfig, service: string | undefined, opts: LogOpts = {}): Promise<void> {
  requireDocker();
  const prefix = dockerPrefix(config);
  const tail = String(opts.tail ?? 200);

  if (service) {
    const resolved = service === "slack" ? "core" : service;
    if (service === "slack") note("slack is a virtual service; showing core logs");
    const name = `${prefix}-${resolved}`;
    if (!containerExists(name)) die(`no container ${name} (is the stack up? services: ${config.services.join(", ")})`);
    const args = ["logs", "--tail", tail];
    if (opts.follow) args.push("-f");
    args.push(name);
    dockerInherit(args);
    return;
  }

  const names = listDeploymentContainers(config.orgId);
  if (names.length === 0) die(`no containers for ${config.orgId} (is the stack up? run \`qm up\`)`);
  await streamPrefixedLogs(names, prefix, { follow: opts.follow ?? false, tail });
}

function streamPrefixedLogs(names: string[], prefix: string, opts: { follow: boolean; tail: string }): Promise<void> {
  return streamLabeled(
    names.map((name) => ({
      label: name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name,
      command: "docker",
      args: ["logs", "--tail", opts.tail, ...(opts.follow ? ["-f"] : []), name],
    })),
    (label, line) => note(`${dim(label)} | ${line}`),
  );
}

export async function dockerDown(config: QmConfig, opts: { purge?: boolean } = {}): Promise<void> {
  requireDocker();
  const prefix = dockerPrefix(config);
  header(`qm down — ${config.orgId}`);
  const serviceNames = teardownOrdered(runnableServices(config.services)).map((d) => `${prefix}-${d.name}`);
  const pgName = `${prefix}-pg`;
  const known = new Set([...serviceNames, pgName]);
  const migrationOwners = new Set(listMigrationOwnerContainers(config.orgId));
  const pluginNames = [
    ...new Set([
      ...config.plugins.map((p) => `${prefix}-${p.name}`),
      ...listDeploymentContainers(config.orgId).filter((n) => !known.has(n)),
      ...migrationOwners,
    ]),
  ];
  const candidates = [...pluginNames, ...serviceNames, pgName];
  const present = new Set(psNames(["-a"]));
  const legacyNetworks = new Set<string>();
  const legacyVolumes = new Set<string>();
  for (const name of candidates) {
    if (!present.has(name)) continue;
    const legacy = legacySandboxResources(name);
    for (const network of legacy?.networks ?? []) legacyNetworks.add(network);
    for (const volume of legacy?.volumes ?? []) legacyVolumes.add(volume);
    if (migrationOwners.has(name) && !opts.purge) continue;
    if (legacy?.volumes.length && !opts.purge) {
      step(`stopping ${name}`);
      docker(["stop", "-t", "2", name], /is not running/);
      continue;
    }
    step(`removing ${name}`);
    docker(["rm", "-f", name], /No such container/);
  }
  if (opts.purge) {
    warn("purging Docker networks and volumes (durable data will be lost)");
    for (const network of new Set([
      ...listDeploymentNetworks(config.orgId),
      ...legacyNetworks,
      prefix,
      `${prefix}-deployments`,
    ])) {
      docker(["network", "rm", network], /not found|No such/);
    }
    for (const volume of new Set([
      ...listDeploymentVolumes(config.orgId),
      ...legacyVolumes,
      `${prefix}-pgdata`,
      `${prefix}-coredata`,
    ])) {
      docker(["volume", "rm", volume], /No such volume|not found/);
    }
  }
  ok("down.");
}
