import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, bold, die, dim, errMessage, header, note, ok, step, warn } from "../log.ts";
import {
  capture,
  deploymentSecretValue,
  flyBin,
  isInvalidSecret,
  promptHidden,
  readEnvFile,
  settleAll,
  streamLabeled,
  which,
} from "../util.ts";
import {
  isVirtualService,
  ordered,
  orgEnv,
  runnableServices,
  serviceDef,
  virtualServiceEnv,
  type ServiceCtx,
  type LogOpts,
  type ServiceName,
} from "../services.ts";
import {
  appPrefixOf,
  CONFIG_FILENAME,
  sandboxCoreEnv,
  securityScreenEnv,
  updateConfigImageOverrides,
  type QmConfig,
} from "../config.ts";
import { discoverPlugins, type ResolvedPlugin } from "../plugins.ts";
import { computedSecrets, runtimeSecretNames, secretDestinations, secretsForService } from "../secrets.ts";
import { flySandboxRepository, imageRepository, pinnedByDigest, recordSandboxPin } from "../commands/sandbox.ts";
import { manifestRef } from "../manifest.ts";
import { CONNECTIVITY_CODES, CoreUnreachableError, type DeploymentLayerTransport } from "../deployment-layer.ts";

const flyServiceCtx = (config: QmConfig, appPrefix: string, deployAppPrefix: string): ServiceCtx => ({
  appPrefix,
  orgId: config.orgId,
  deployAppPrefix,
  publicUrl: config.publicUrl,
  hasPortal: config.services.includes("portal"),
  hasAuth: config.services.includes("auth"),
  ...(config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN
    ? { authAllowedEmailDomain: config.env.auth.AUTH_ALLOWED_EMAIL_DOMAIN }
    : {}),
  coreUrl: `http://${appPrefix}-core.internal:8080`,
  authUrl: `http://${appPrefix}-auth.flycast`,
});

const FLY_RESPONSE = "QM_LAYER_RESPONSE=";
const FLY_REMOTE_ERROR = "QM_LAYER_ERROR=";
const FLY_REQUEST_TIMEOUT_MS = 120_000;

function flyRequest(config: QmConfig, method: "GET" | "PUT", body: string): { status: number; body: string } {
  const app = `${appPrefixOf(config)}-core`;
  const script = `const fs=require("node:fs"),{createHmac}=require("node:crypto");const fail=error=>{const code=error&&(error.cause&&error.cause.code||error.code);console.log(${JSON.stringify(FLY_REMOTE_ERROR)}+JSON.stringify({message:error&&error.message?error.message:String(error),...(typeof code==="string"?{code}:{})}))};try{const method=${JSON.stringify(method)},path="/v1/deployment-layer",body=fs.readFileSync(0,"utf8"),timestamp=Math.floor(Date.now()/1000),canonical=method+"\\n"+path+"\\n"+body,secret=process.env.CORE_SIGNING_SECRET;if(!secret)throw new Error("CORE_SIGNING_SECRET is not set on core");const signature=createHmac("sha256",secret).update("v0:"+timestamp+":"+canonical).digest("hex");fetch("http://127.0.0.1:"+(process.env.PORT||8080)+path,{method,headers:{"content-type":"application/json","x-timestamp":String(timestamp),"x-signature":"v0="+signature},...(method==="PUT"?{body}: {})}).then(async response=>console.log(${JSON.stringify(FLY_RESPONSE)}+JSON.stringify({status:response.status,body:await response.text()}))).catch(fail)}catch(error){fail(error)}`;
  const encoded = Buffer.from(script).toString("base64");
  const command = `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
  let output: string;
  try {
    output = execFileSync(flyBin(), ["ssh", "console", "-a", app, "-C", command], {
      encoding: "utf8",
      input: body,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: FLY_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const text = `${detail.stderr ?? ""}${detail.stdout ?? ""}`.trim() || detail.message || "fly ssh failed";
    if (/could not find app|app not found/i.test(text)) throw new CliError(`Fly app ${app} not found: ${text}`);
    throw new CoreUnreachableError(`could not reach the Fly core: ${text}`);
  }
  const remoteError = output.split("\n").find((value) => value.startsWith(FLY_REMOTE_ERROR));
  if (remoteError) {
    const detail = JSON.parse(remoteError.slice(FLY_REMOTE_ERROR.length)) as { message?: string; code?: string };
    const message = detail.message ?? "deployment-layer request failed on the core";
    if (detail.code && CONNECTIVITY_CODES.has(detail.code)) {
      throw new CoreUnreachableError(`the core process on ${app} is not accepting connections: ${message}`);
    }
    throw new CliError(`deployment-layer request failed on ${app}: ${message}`);
  }
  const line = output.split("\n").find((value) => value.startsWith(FLY_RESPONSE));
  if (!line) throw new CliError(`Fly core returned no deployment-layer response`);
  return JSON.parse(line.slice(FLY_RESPONSE.length)) as { status: number; body: string };
}

/** Deployment-layer transport for Fly: a signed request executed on the core VM over fly ssh. */
export const flyDeploymentLayerTransport: DeploymentLayerTransport = (opts) =>
  Promise.resolve(flyRequest(opts.config, opts.method, opts.body));

import { doctorCommon, localDoctorSecrets, requireFlyAuth } from "./doctor.ts";

export interface FlyUpOpts {
  dryRun?: boolean;
  buildOnly?: boolean;
  buildFrom?: boolean;
  buildFromPath?: string;
  configPath?: string;
  only?: string[];
  imageFrom?: string;
  imageLabel?: string;
  imageRepoPrefix?: string;
}

interface FlyCtx {
  config: QmConfig;
  templateRoot: string;
  generatedRoot: string;
  commandCwd: string;
  sourceRoot?: string;
  appPrefix: string;
  orgId: string;
  region: string;
  flyOrg: string;
  serviceCtx: ServiceCtx;
}

interface DeployTiming {
  stack: string;
  service: string;
  phase: string;
  durationMs: number;
}

type ImageSource =
  { kind: "current"; appPrefix: string } | { kind: "tagged"; appPrefix: string; label: string } | { kind: "manifest" };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function markdownCell(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function appendGithubTimingSummary(rows: DeployTiming[]): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path || rows.length === 0) return;

  const stack = rows[0]?.stack ?? "unknown";
  const lines = [
    "",
    `### Fly deploy timings (${markdownCell(stack)})`,
    "",
    "| Stack | Service | Phase | Duration |",
    "| --- | --- | --- | ---: |",
    ...rows.map(
      (r) =>
        `| ${markdownCell(r.stack)} | ${markdownCell(r.service)} | ${markdownCell(r.phase)} | ${markdownCell(formatDuration(r.durationMs))} |`,
    ),
    "",
  ];
  try {
    appendFileSync(path, `${lines.join("\n")}\n`);
  } catch {
    void 0;
  }
}

function createTimingRecorder(stack: string): {
  rows: DeployTiming[];
  time: <T>(service: string, phase: string, fn: () => T) => T;
  timeAsync: <T>(service: string, phase: string, fn: () => Promise<T>) => Promise<T>;
} {
  const rows: DeployTiming[] = [];
  const record = (service: string, phase: string, startedAt: bigint): void => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    rows.push({ stack, service, phase, durationMs });
    step(`timing ${stack}/${service}: ${phase} ${formatDuration(durationMs)}`);
  };
  return {
    rows,
    time<T>(service: string, phase: string, fn: () => T): T {
      const start = process.hrtime.bigint();
      try {
        return fn();
      } finally {
        record(service, phase, start);
      }
    },
    async timeAsync<T>(service: string, phase: string, fn: () => Promise<T>): Promise<T> {
      const start = process.hrtime.bigint();
      try {
        return await fn();
      } finally {
        record(service, phase, start);
      }
    },
  };
}

function fly(args: string[], opts: { allow?: RegExp } = {}): string {
  try {
    return capture(flyBin(), args, opts);
  } catch (e) {
    throw new CliError(errMessage(e));
  }
}

function stageSecret(app: string, name: string, value: string): void {
  const result = spawnSync(flyBin(), ["secrets", "set", "--stage", "-a", app, `${name}=-`], {
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new CliError(`failed to stage ${name} on ${app}`);
}

function flySensitive(args: string[], failure: string): string {
  const result = spawnSync(flyBin(), args, { encoding: "utf8" });
  if (result.status !== 0) throw new CliError(failure);
  return result.stdout;
}

const tomlStr = (v: string): string => JSON.stringify(v);
const FLY_DEPLOYMENT_ID_ENV = "QM_DEPLOYMENT_ID";
const flyDeploymentId = (flyOrg: string, orgId: string, appPrefix: string): string =>
  `qm-v2:${flyOrg}:${orgId}:${appPrefix}`;
const flyOwnershipMarker = (flyOrg: string, orgId: string, appPrefix: string): string =>
  `QM_OWNER_${createHash("sha256")
    .update(flyDeploymentId(flyOrg, orgId, appPrefix))
    .digest("hex")
    .slice(0, 16)
    .toUpperCase()}`;

function deriveToml(ctx: FlyCtx, service: ServiceName): string {
  const spec = serviceDef(service).fly!;
  const nested = join(ctx.templateRoot, service, "fly.toml");
  const base = readFileSync(existsSync(nested) ? nested : join(ctx.templateRoot, `${service}.toml`), "utf8");
  const sandboxEnv = service === "core" ? sandboxCoreEnv(ctx.config).env : {};
  const virtualEnv = service === "core" ? virtualServiceEnv(ctx.config.services, ctx.config.env) : {};
  const modelEnv: Record<string, string> =
    service === "core"
      ? {
          ...(ctx.config.model ? { PI_MODEL: ctx.config.model } : {}),
          ...(ctx.config.modelProvider ? { MODEL_PROVIDER: ctx.config.modelProvider } : {}),
        }
      : {};
  const configuredEnv = { ...ctx.config.env[service] };
  if (service === "core") {
    delete configuredEnv.FLY_ORG;
    delete configuredEnv.FLY_DEPLOY_BASE_IMAGE;
  }
  const deploymentEnv =
    service === "core"
      ? {
          ...(ctx.flyOrg ? { FLY_ORG: ctx.flyOrg } : {}),
          ...(sandboxEnv.FLY_BASE_IMAGE ? { FLY_DEPLOY_BASE_IMAGE: sandboxEnv.FLY_BASE_IMAGE } : {}),
        }
      : {};
  const overrides: Record<string, string> = {
    ...spec.managed(ctx.serviceCtx),
    ...sandboxEnv,
    ...virtualEnv,
    ...modelEnv,
    ...configuredEnv,
    ...(service === "core" ? securityScreenEnv(ctx.config) : {}),
    ...deploymentEnv,
    [FLY_DEPLOYMENT_ID_ENV]: flyDeploymentId(ctx.flyOrg, ctx.orgId, ctx.appPrefix),
  };
  const provided = new Set(Object.keys(overrides));
  const vm = ctx.config.vms?.[service];
  const lines = base.split("\n");
  const out: string[] = [];
  let inEnv = false;
  let inVm = false;
  let envIndent = "  ";
  const seen = new Set<string>();
  for (const line of lines) {
    const section = line.match(/^\s*\[(.+)\]\s*$/);
    if (section) {
      if (inEnv) out.splice(out.length, 0, ...pendingExtra());
      inEnv = section[1] === "env";
      inVm = section[1] === "[vm]";
      out.push(line);
      continue;
    }
    if (line.startsWith("app = ")) {
      out.push(`app = ${tomlStr(`${ctx.appPrefix}-${service}`)}`);
      continue;
    }
    const regionM = line.match(/^(\s*)primary_region\s*=\s*".*"\s*$/);
    if (regionM) {
      out.push(`${regionM[1]}primary_region = ${tomlStr(ctx.region)}`);
      continue;
    }
    if (inVm && vm) {
      const sizeM = line.match(/^(\s*)size\s*=\s*".*"\s*$/);
      if (sizeM && vm.size !== undefined) {
        out.push(`${sizeM[1]}size = ${tomlStr(vm.size)}`);
        continue;
      }
      const memM = line.match(/^(\s*)memory\s*=\s*".*"\s*$/);
      if (memM && vm.memory !== undefined) {
        out.push(`${memM[1]}memory = ${tomlStr(vm.memory)}`);
        continue;
      }
    }
    if (inEnv) {
      const kv = line.match(/^(\s*)([A-Za-z0-9_]+)\s*=\s*".*"\s*$/);
      if (kv) {
        const indent = kv[1] ?? "";
        const key = kv[2] ?? "";
        envIndent = indent;
        seen.add(key);
        const ov = overrides[key];
        if (ov !== undefined) {
          out.push(`${indent}${key} = ${tomlStr(ov)}`);
          continue;
        }
        if (spec.stackKeys.includes(key) && !provided.has(key)) continue;
      }
    }
    out.push(line);
  }
  if (inEnv) out.push(...pendingExtra());
  return out.join("\n");

  function pendingExtra(): string[] {
    return Object.entries(overrides)
      .filter(([k]) => !seen.has(k))
      .map(([k, v]) => `${envIndent}${k} = ${tomlStr(v)}`);
  }
}

export function derivedTomlFor(config: QmConfig, service: ServiceName, repoRoot: string): string {
  const appPrefix = appPrefixOf(config);
  const deployAppPrefix = config.deployAppPrefix ?? `${appPrefix}-d`;
  const ctx: FlyCtx = {
    config,
    templateRoot: join(repoRoot, "deploy"),
    generatedRoot: join(repoRoot, "deploy", "stacks", ".generated"),
    commandCwd: repoRoot,
    sourceRoot: repoRoot,
    appPrefix,
    orgId: config.orgId,
    region: config.region ?? "",
    flyOrg: config.flyOrg ?? "",
    serviceCtx: flyServiceCtx(config, appPrefix, deployAppPrefix),
  };
  return deriveToml(ctx, service);
}

const generatedDir = (ctx: FlyCtx): string => join(ctx.generatedRoot, ctx.appPrefix);

const serviceCfgPath = (ctx: FlyCtx, service: ServiceName): string => join(generatedDir(ctx), `${service}.fly.toml`);

function writeDerived(ctx: FlyCtx, service: ServiceName): string {
  mkdirSync(generatedDir(ctx), { recursive: true });
  const path = serviceCfgPath(ctx, service);
  writeFileSync(path, deriveToml(ctx, service));
  return path;
}

const FLY_APP_NOT_FOUND = /app not found|Could not find App/i;

function secretNames(app: string): Set<string> | undefined {
  const out = fly(["secrets", "list", "-a", app], { allow: FLY_APP_NOT_FOUND });
  if (FLY_APP_NOT_FOUND.test(out)) return undefined;
  return new Set(
    [...out.matchAll(/^\s*\*?\s*([A-Z0-9_]+)\s/gm)].map((m) => m[1]).filter((s): s is string => s !== undefined),
  );
}

function flyProviderSecrets(config: QmConfig, workload: string): string[] {
  if (workload !== "core") return [];
  const core = config.env.core ?? {};
  if (core.SNAPSHOT_STORE !== "s3" && core.TRANSFER_STORE !== "s3") return [];
  return ["AWS_ACCESS_KEY_ID", "AWS_ENDPOINT_URL_S3", "AWS_SECRET_ACCESS_KEY"];
}

function ensureObjectStorage(ctx: FlyCtx): void {
  const required = flyProviderSecrets(ctx.config, "core");
  if (!required.length) return;
  const app = `${ctx.appPrefix}-core`;
  if (required.every((name) => secretNames(app)?.has(name))) {
    note(`object storage: credentials already set on ${app}`);
    return;
  }
  const bucket = ctx.config.env.core?.S3_BUCKET?.trim();
  if (!bucket) throw new CliError("Fly S3 storage requires env.core.S3_BUCKET");
  note(`object storage: creating private Tigris bucket ${bucket}…`);
  fly(["storage", "create", "--name", bucket, "--app", app, "--org", ctx.flyOrg, "--yes"]);
  const missing = required.filter((name) => !secretNames(app)?.has(name));
  if (missing.length) throw new CliError(`Fly storage create did not attach ${missing.join(", ")} to ${app}`);
  note(`object storage: credentials staged on ${app}`);
}

function generatedTomlEnv(toml: string): Record<string, string> {
  const env: Record<string, string> = {};
  let inEnv = false;
  for (const line of toml.split("\n")) {
    const section = line.match(/^\s*\[(.+)\]\s*$/);
    if (section) {
      inEnv = section[1] === "env";
      continue;
    }
    if (!inEnv) continue;
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/);
    if (match?.[1] && match[2]) env[match[1]] = JSON.parse(match[2]) as string;
  }
  return env;
}

const S3_PROBE_SOURCE = `
(async () => {
const { randomUUID } = require("node:crypto");
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const bucket = process.env.S3_BUCKET;
if (!bucket) throw new Error("S3_BUCKET is missing");
const body = "qm-storage-probe-" + randomUUID();
const key = "qm-health/" + randomUUID();
const client = new S3Client({
  region: process.env.S3_REGION || "auto",
  ...(process.env.AWS_ENDPOINT_URL_S3 ? { endpoint: process.env.AWS_ENDPOINT_URL_S3 } : {}),
});
try {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body || await result.Body.transformToString() !== body) throw new Error("S3 round-trip mismatch");
} finally {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

export function flyS3ProbeCommand(): string {
  const encoded = Buffer.from(S3_PROBE_SOURCE).toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

function flyS3RoundTrip(app: string, machineId: string): void {
  fly(["ssh", "console", "-a", app, "--machine", machineId, "--command", flyS3ProbeCommand(), "--quiet"]);
}

export function flyLiveSessionCommand(): string {
  return "node src/deployment/postdeploy-smoke.ts session http://127.0.0.1:8080";
}

function flyLiveSession(app: string, machineId: string): void {
  fly(["ssh", "console", "-a", app, "--machine", machineId, "--command", flyLiveSessionCommand(), "--quiet"]);
}

function flyOrgApps(flyOrg: string): Set<string> {
  const raw = fly(["apps", "list", "--org", flyOrg, "--json"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`fly apps list returned invalid JSON for organization ${flyOrg}`);
  }
  if (!Array.isArray(parsed)) throw new CliError(`fly apps list returned a non-array for organization ${flyOrg}`);
  return new Set(
    parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const name = String(
        (entry as Record<string, unknown>).Name ?? (entry as Record<string, unknown>).name ?? "",
      ).trim();
      return name ? [name] : [];
    }),
  );
}

function appHasMachines(app: string): boolean {
  try {
    const parsed = JSON.parse(fly(["status", "-a", app, "--json"])) as { Machines?: unknown[] };
    return (parsed.Machines?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function ensureApp(app: string, flyOrg: string, orgId: string, appPrefix: string): void {
  const out = fly(["apps", "create", app, "--org", flyOrg], { allow: /already been taken/i });
  const marker = flyOwnershipMarker(flyOrg, orgId, appPrefix);
  if (/already been taken/i.test(out)) {
    if (!flyOrgApps(flyOrg).has(app)) {
      throw new CliError(`app ${app} exists outside configured Fly organization ${flyOrg}; choose another appPrefix`);
    }
    if (!secretNames(app)?.has(marker)) {
      throw new CliError(
        `app ${app} already exists but is not marked as owned by this deployment; ` +
          `choose another appPrefix or explicitly remove the conflicting app`,
      );
    }
    note(`app ${app}: owned by this deployment`);
    return;
  }
  fly(["secrets", "set", "--stage", "-a", app, `${marker}=1`]);
  note(`app ${app}: created`);
}

function assertOwnedApp(app: string, flyOrg: string, orgId: string, appPrefix: string): void {
  if (!flyOrgApps(flyOrg).has(app)) {
    throw new CliError(`app ${app} is not present in configured Fly organization ${flyOrg}`);
  }
  const marker = flyOwnershipMarker(flyOrg, orgId, appPrefix);
  if (!secretNames(app)?.has(marker)) {
    throw new CliError(`app ${app} is not marked as owned by deployment ${flyDeploymentId(flyOrg, orgId, appPrefix)}`);
  }
}

function ensurePostgres(ctx: FlyCtx): void {
  const app = `${ctx.appPrefix}-core`;
  const hasDatabaseUrl = secretNames(app)?.has("DATABASE_URL");
  if (hasDatabaseUrl) {
    note(`postgres: DATABASE_URL already set on ${app}`);
    return;
  }
  const pgName = `${ctx.appPrefix}-pg`;
  const list = fly(["mpg", "list", "--org", ctx.flyOrg]);
  let id = mpgClusterId(list, pgName);
  if (!id) {
    note(`postgres: creating cluster ${pgName} (basic plan)…`);
    const created = fly([
      "mpg",
      "create",
      "--org",
      ctx.flyOrg,
      "--region",
      ctx.region,
      "--name",
      pgName,
      "--plan",
      "basic",
    ]);
    id = created.match(/ID:\s*(\S+)/)?.[1];
    if (!id) throw new CliError(`could not parse cluster id from mpg create output:\n${created}`);
  }
  const status = flySensitive(["mpg", "status", id, "--json"], "failed to read Managed Postgres connection details");
  stageSecret(app, "DATABASE_URL", mpgDirectUrl(status, id));
  note(`postgres: direct connection staged on ${app}`);
}

export function mpgClusterId(listOutput: string, name: string): string | undefined {
  return listOutput
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((fields) => fields.includes(name))?.[0];
}

export function mpgDirectUrl(statusOutput: string, clusterId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusOutput);
  } catch {
    throw new CliError("fly mpg status returned invalid JSON");
  }
  const credentials =
    parsed && typeof parsed === "object"
      ? (parsed as { credentials?: { direct_uri?: unknown; pgbouncer_uri?: unknown } }).credentials
      : undefined;
  const value = credentials?.direct_uri ?? credentials?.pgbouncer_uri;
  if (typeof value !== "string" || !value) {
    throw new CliError("fly mpg status did not return a database connection URI");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("fly mpg status returned an invalid database connection URI");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new CliError("fly mpg status returned an invalid database connection scheme");
  }
  const pooledHost = `pgbouncer.${clusterId}.flympg.net`;
  const directHost = `direct.${clusterId}.flympg.net`;
  if (url.hostname === pooledHost) {
    url.hostname = directHost;
  } else if (url.hostname !== directHost) {
    throw new CliError("fly mpg status returned an unrecognized database hostname");
  }
  return url.toString();
}

function ensureFlycast(app: string): void {
  const ips = fly(["ips", "list", "-a", app]);
  if (/private/i.test(ips)) return;
  fly(["ips", "allocate-v6", "--private", "-a", app]);
  note(`flycast: allocated private v6 for ${app}`);
}

interface FlyImageDetail {
  digest: string;
  immutableReference: string;
  machineId?: string;
  reference: string;
}

function flyImageDetails(app: string): FlyImageDetail[] {
  const parsed = JSON.parse(fly(["image", "show", "-a", app, "--json"])) as unknown;
  if (!Array.isArray(parsed)) throw new CliError(`fly image show returned invalid JSON for ${app}`);
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { Digest, MachineID, Registry, Repository, Tag } = entry as Record<string, unknown>;
    if (
      typeof Digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(Digest) ||
      typeof Registry !== "string" ||
      typeof Repository !== "string"
    )
      return [];
    return [
      {
        digest: Digest,
        immutableReference: `${Registry}/${Repository}@${Digest}`,
        ...(typeof MachineID === "string" ? { machineId: MachineID } : {}),
        reference: `${Registry}/${Repository}${typeof Tag === "string" ? `:${Tag}` : ""}`,
      },
    ];
  });
}

function currentImage(app: string): string {
  const out = fly(["status", "-a", app, "--json"]);
  const machine = (JSON.parse(out) as { Machines?: Array<{ id?: string; ID?: string; config?: { image?: string } }> })
    .Machines?.[0];
  const image = machine?.config?.image;
  if (!image) throw new CliError(`no running machine/image found on ${app}`);
  if (/@sha256:[a-f0-9]{64}$/.test(image)) return image;
  const machineId = machine.id ?? machine.ID;
  const resolved = flyImageDetails(app).find((entry) =>
    machineId ? entry.machineId === machineId : entry.reference === image,
  );
  if (!resolved) throw new CliError(`${app} did not report an immutable image digest`);
  return resolved.immutableReference;
}

function recordServiceImages(ctx: FlyCtx, services: ServiceName[], selectedConfigPath?: string): void {
  const configPath = selectedConfigPath ?? join(ctx.commandCwd, CONFIG_FILENAME);
  if (!existsSync(configPath)) return;
  const images = Object.fromEntries(
    services.map((service) => {
      const image = currentImage(`${ctx.appPrefix}-${service}`);
      if (!/@sha256:[a-f0-9]{64}$/.test(image)) {
        throw new CliError(`${ctx.appPrefix}-${service} did not report an immutable image digest after deployment`);
      }
      return [service, image];
    }),
  );
  writeFileSync(configPath, updateConfigImageOverrides(readFileSync(configPath, "utf8"), images));
  ok(`recorded ${services.length} immutable service image pin${services.length === 1 ? "" : "s"} in ${configPath}`);
}

function flyTaggedImage(appPrefix: string, service: string, label: string): string {
  return `registry.fly.io/${appPrefix}-${service}:${label}`;
}

function imageSourceFor(ctx: FlyCtx, opts: FlyUpOpts): ImageSource | undefined {
  if (opts.imageLabel)
    return { kind: "tagged", appPrefix: opts.imageRepoPrefix ?? ctx.appPrefix, label: opts.imageLabel };
  if (opts.imageFrom) return { kind: "current", appPrefix: opts.imageFrom };
  if (ctx.sourceRoot) return undefined;
  if (ctx.config.imageFrom) return { kind: "current", appPrefix: ctx.config.imageFrom };
  return { kind: "manifest" };
}

const SAFE_AFTER_CORE = new Set<ServiceName>(["web-ui", "admin", "portal", "auth"]);

export function flyDeployPhases(services: ServiceName[]): ServiceName[][] {
  const phases: ServiceName[][] = [];
  const remaining = [...services];
  const coreIndex = remaining.indexOf("core");
  if (coreIndex !== -1) {
    phases.push(["core"]);
    remaining.splice(coreIndex, 1);
  }
  const parallel = remaining.filter((s) => SAFE_AFTER_CORE.has(s));
  if (parallel.length) phases.push(parallel);
  for (const s of remaining) {
    if (!SAFE_AFTER_CORE.has(s)) phases.push([s]);
  }
  return phases;
}

function resolveServices(config: QmConfig, only?: ServiceName[]): ServiceName[] {
  const runnable = runnableServices(config.services);
  for (const s of runnable) {
    if (!serviceDef(s).fly) {
      throw new CliError(
        `service "${s}" is not deployable via the fly target — deploy it manually (see deploy/README.md). ` +
          `Remove it from "services" or use the docker target.`,
      );
    }
  }
  if (only) {
    for (const s of only) {
      if (!runnable.includes(s)) throw new CliError(`--only "${s}" is not in this deployment's services`);
    }
  }
  return ordered(runnable)
    .map((d) => d.name)
    .filter((s) => !only || only.includes(s));
}

function sourceRootFor(configDir: string, explicit?: string): string | undefined {
  if (explicit) {
    const root = resolve(explicit);
    return existsSync(join(root, "package.json")) &&
      existsSync(join(root, "src", "index.ts")) &&
      existsSync(join(root, "deploy", "core", "fly.toml")) &&
      existsSync(join(root, "deploy", "core", "Dockerfile"))
      ? root
      : undefined;
  }
  const candidates: string[] = [];
  for (const cwd of new Set([configDir, process.cwd()])) {
    try {
      candidates.push(capture("git", ["rev-parse", "--show-toplevel"], { cwd }).trim());
    } catch {
      void 0;
    }
  }
  candidates.push(fileURLToPath(new URL("../../../", import.meta.url)));
  return candidates.find(
    (root) =>
      existsSync(join(root, "package.json")) &&
      existsSync(join(root, "src", "index.ts")) &&
      existsSync(join(root, "deploy", "core", "fly.toml")) &&
      existsSync(join(root, "deploy", "core", "Dockerfile")),
  );
}

function packagedFlyTemplateRoot(): string {
  const source = fileURLToPath(new URL("../../templates/fly", import.meta.url));
  if (existsSync(source)) return source;
  return fileURLToPath(new URL("../../../templates/fly", import.meta.url));
}

function buildCtx(config: QmConfig, configDir: string, opts: Pick<FlyUpOpts, "buildFrom" | "buildFromPath">): FlyCtx {
  const sourceRoot = opts.buildFrom ? sourceRootFor(configDir, opts.buildFromPath) : undefined;
  if (opts.buildFrom && !sourceRoot) {
    throw new CliError(`--build-from requires a QM checkout containing src/ and deploy/<service>/Dockerfile`);
  }
  const appPrefix = appPrefixOf(config);
  if (!config.flyOrg)
    throw new CliError(`config: "flyOrg" is required for the fly target (the Fly org slug that owns the apps)`);
  if (!config.region) throw new CliError(`config: "region" is required for the fly target (e.g. "sjc")`);
  const deployAppPrefix = config.deployAppPrefix ?? `${appPrefix}-d`;
  return {
    config,
    templateRoot: sourceRoot ? join(sourceRoot, "deploy") : packagedFlyTemplateRoot(),
    generatedRoot: join(configDir, ".generated", "fly"),
    commandCwd: configDir,
    ...(sourceRoot ? { sourceRoot } : {}),
    appPrefix,
    orgId: config.orgId,
    region: config.region,
    flyOrg: config.flyOrg,
    serviceCtx: flyServiceCtx(config, appPrefix, deployAppPrefix),
  };
}

async function deployService(
  ctx: FlyCtx,
  service: ServiceName,
  imageSource: ImageSource | undefined,
  timing: ReturnType<typeof createTimingRecorder>,
): Promise<void> {
  const app = `${ctx.appPrefix}-${service}`;
  const spec = serviceDef(service).fly!;
  note(`\n=== deploying ${app} ===`);
  if (service === "core") timing.time(service, "Postgres ensure", () => ensurePostgres(ctx));
  if (spec.flycast) timing.time(service, "Flycast ensure", () => ensureFlycast(app));
  const cfgPath = serviceCfgPath(ctx, service);
  const args = ["deploy", "--yes", "-c", cfgPath, ...spec.deployFlags];
  if (imageSource?.kind === "tagged") {
    args.push("--image", flyTaggedImage(imageSource.appPrefix, service, imageSource.label));
  } else if (imageSource?.kind === "current") {
    args.push(
      "--image",
      timing.time(service, "current image lookup", () => currentImage(`${imageSource.appPrefix}-${service}`)),
    );
  } else if (imageSource?.kind === "manifest") {
    args.push("--image", ctx.config.imageOverrides[service] ?? manifestRef(service));
  } else {
    args.push("--remote-only", "--dockerfile", join(ctx.sourceRoot!, "deploy", service, "Dockerfile"), ctx.sourceRoot!);
  }
  step(`fly ${args.join(" ")}`);

  await timing.timeAsync(service, "fly deploy", () => runFlyDeploy(args, ctx.commandCwd));
}

async function deployPhase(
  ctx: FlyCtx,
  phase: ServiceName[],
  imageSource: ImageSource | undefined,
  timing: ReturnType<typeof createTimingRecorder>,
): Promise<void> {
  if (phase.length > 1)
    note(`\n=== deploying in parallel: ${phase.map((s) => `${ctx.appPrefix}-${s}`).join(", ")} ===`);
  await settleAll(phase.map((s) => deployService(ctx, s, imageSource, timing)));
}

async function buildServiceImage(
  ctx: FlyCtx,
  service: ServiceName,
  label: string,
  timing: ReturnType<typeof createTimingRecorder>,
): Promise<void> {
  const app = `${ctx.appPrefix}-${service}`;
  const spec = serviceDef(service).fly!;
  note(`\n=== building image ${flyTaggedImage(ctx.appPrefix, service, label)} ===`);
  const cfgPath = serviceCfgPath(ctx, service);
  const args = [
    "deploy",
    "--yes",
    "--build-only",
    "--push",
    "--image-label",
    label,
    "-c",
    cfgPath,
    ...spec.deployFlags,
    "--remote-only",
    "--dockerfile",
    join(ctx.sourceRoot!, "deploy", service, "Dockerfile"),
    ctx.sourceRoot!,
  ];
  step(`fly ${args.join(" ")}`);

  await timing.timeAsync(service, "image build", () => runFlyDeploy(args, ctx.commandCwd));
  note(`image: ${app} -> ${flyTaggedImage(ctx.appPrefix, service, label)}`);
}

async function buildImages(
  ctx: FlyCtx,
  services: ServiceName[],
  label: string,
  timing: ReturnType<typeof createTimingRecorder>,
): Promise<void> {
  await settleAll(services.map((s) => buildServiceImage(ctx, s, label, timing)));
}

const pluginApp = (ctx: FlyCtx, name: string): string => `${ctx.appPrefix}-${name}`;

function pluginCfgPath(ctx: FlyCtx, name: string): string {
  return join(generatedDir(ctx), `plugin-${name}.fly.toml`);
}

function pluginTomlContent(
  appPrefix: string,
  flyOrg: string,
  orgId: string,
  publicUrl: string,
  hasPortal: boolean,
  region: string,
  plugin: ResolvedPlugin,
): string {
  const env: Record<string, string> = {
    CORE_API_URL: `http://${appPrefix}-core.internal:8080`,
    ...orgEnv(plugin.name, orgId, publicUrl, hasPortal),
    PORT: "8080",
    ...plugin.env,
    [FLY_DEPLOYMENT_ID_ENV]: flyDeploymentId(flyOrg, orgId, appPrefix),
  };
  const lines = [`app = ${tomlStr(`${appPrefix}-${plugin.name}`)}`, `primary_region = ${tomlStr(region)}`, "", "[env]"];
  for (const [k, v] of Object.entries(env)) lines.push(`  ${k} = ${tomlStr(v)}`);
  lines.push(
    "",
    "[checks]",
    "  [checks.ready]",
    '    type = "tcp"',
    "    port = 8080",
    '    interval = "15s"',
    '    timeout = "2s"',
    '    grace_period = "20s"',
  );
  return lines.join("\n") + "\n";
}

export function derivedPluginTomlFor(config: QmConfig, plugin: ResolvedPlugin): string {
  return pluginTomlContent(
    appPrefixOf(config),
    config.flyOrg ?? "",
    config.orgId,
    config.publicUrl,
    config.services.includes("portal"),
    config.region ?? "",
    plugin,
  );
}

function writePluginDerived(ctx: FlyCtx, plugin: ResolvedPlugin): string {
  mkdirSync(generatedDir(ctx), { recursive: true });
  const path = pluginCfgPath(ctx, plugin.name);
  writeFileSync(
    path,
    pluginTomlContent(
      ctx.appPrefix,
      ctx.flyOrg,
      ctx.orgId,
      ctx.config.publicUrl,
      ctx.config.services.includes("portal"),
      ctx.region,
      plugin,
    ),
  );
  return path;
}

async function buildPluginImage(
  ctx: FlyCtx,
  plugin: ResolvedPlugin,
  label: string,
  timing: ReturnType<typeof createTimingRecorder>,
): Promise<void> {
  const app = pluginApp(ctx, plugin.name);
  note(`\n=== building plugin image ${flyTaggedImage(ctx.appPrefix, plugin.name, label)} ===`);
  const cfgPath = pluginCfgPath(ctx, plugin.name);
  const args = [
    "deploy",
    "--yes",
    "--build-only",
    "--push",
    "--image-label",
    label,
    "-c",
    cfgPath,
    "--ha=false",
    "--remote-only",
    "--dockerfile",
    plugin.dockerfile!,
    plugin.sourceDir!,
  ];
  step(`fly ${args.join(" ")}`);
  await timing.timeAsync(plugin.name, "image build", () => runFlyDeploy(args, ctx.commandCwd));
  note(`image: ${app} -> ${flyTaggedImage(ctx.appPrefix, plugin.name, label)}`);
}

async function deployPlugin(
  ctx: FlyCtx,
  plugin: ResolvedPlugin,
  imageSource: ImageSource | undefined,
  timing: ReturnType<typeof createTimingRecorder>,
): Promise<void> {
  const app = pluginApp(ctx, plugin.name);
  note(`\n=== deploying plugin ${app} (${plugin.kind}) ===`);
  const cfgPath = pluginCfgPath(ctx, plugin.name);
  const args = ["deploy", "--yes", "-c", cfgPath, "--ha=false"];
  if (imageSource?.kind === "tagged") {
    args.push("--image", flyTaggedImage(imageSource.appPrefix, plugin.name, imageSource.label));
  } else if (imageSource?.kind === "current") {
    args.push(
      "--image",
      timing.time(plugin.name, "current image lookup", () => currentImage(`${imageSource.appPrefix}-${plugin.name}`)),
    );
  } else if (plugin.kind === "image") {
    args.push("--image", plugin.image!);
  } else {
    args.push("--remote-only", "--dockerfile", plugin.dockerfile!, plugin.sourceDir!);
  }
  step(`fly ${args.join(" ")}`);
  await timing.timeAsync(plugin.name, "fly deploy", () => runFlyDeploy(args, ctx.commandCwd));
}

async function deployPlugins(
  ctx: FlyCtx,
  plugins: ResolvedPlugin[],
  imageSource: ImageSource | undefined,
  timing: ReturnType<typeof createTimingRecorder>,
): Promise<void> {
  if (!plugins.length) return;
  note(`\n=== deploying plugins: ${plugins.map((p) => pluginApp(ctx, p.name)).join(", ")} ===`);
  await settleAll(plugins.map((p) => deployPlugin(ctx, p, imageSource, timing)));
}

function runFlyDeploy(args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(flyBin(), args, { stdio: "inherit", cwd });
    child.on("error", (err) => reject(new CliError(`fly ${args.join(" ")} failed:\n${err.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new CliError(`fly ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`),
        );
    });
  });
}

function unsetDisabledSecurityScreenToken(config: QmConfig, appPrefix: string): void {
  if (config.securityScreen) return;
  const app = `${appPrefix}-core`;
  if (!secretNames(app)?.has("SECURITY_SCREEN_PROXY_TOKEN")) return;
  fly(["secrets", "unset", "--stage", "-a", app, "SECURITY_SCREEN_PROXY_TOKEN"]);
  note(`removed the disabled security screen token from ${app}`);
}

function unsetDisabledFlyPublisherToken(config: QmConfig, appPrefix: string): void {
  if (config.env.core?.DEPLOY_PROVIDER === "fly") return;
  const app = `${appPrefix}-core`;
  if (!secretNames(app)?.has("FLY_DEPLOY_API_TOKEN")) return;
  fly(["secrets", "unset", "--stage", "-a", app, "FLY_DEPLOY_API_TOKEN"]);
  note(`removed the disabled Fly app publisher token from ${app}`);
}

export async function flyUp(config: QmConfig, configDir: string, opts: FlyUpOpts = {}): Promise<void> {
  if (opts.imageLabel && opts.imageFrom) {
    throw new CliError("--image-label and --image-from select different image sources and cannot be combined");
  }
  if (opts.buildFrom && (opts.imageLabel || opts.imageFrom || opts.imageRepoPrefix)) {
    throw new CliError("--build-from cannot be combined with --image-label, --image-from, or --image-repo-prefix");
  }
  if (opts.buildOnly && (opts.imageFrom || opts.imageRepoPrefix)) {
    throw new CliError("--build-only cannot be combined with --image-from or --image-repo-prefix");
  }
  const buildFrom = opts.buildFrom || opts.buildOnly;
  const ctx = buildCtx(config, configDir, { buildFrom, buildFromPath: opts.buildFromPath });
  const allPlugins = discoverPlugins(configDir, config).plugins;
  let onlyServices: ServiceName[] | undefined;
  let plugins = allPlugins;
  if (opts.only) {
    const serviceSet = new Set<string>(config.services);
    const pluginSet = new Set(allPlugins.map((p) => p.name));
    const svc: ServiceName[] = [];
    const plg = new Set<string>();
    for (const name of opts.only) {
      if (serviceSet.has(name)) {
        if (isVirtualService(name)) {
          throw new CliError(
            `--only "${name}": ${name} is a virtual service — it runs in-process on the core, so deploy it with --only core`,
          );
        }
        svc.push(name as ServiceName);
      } else if (pluginSet.has(name)) plg.add(name);
      else {
        throw new CliError(
          `--only "${name}" is not a service or plugin in this deployment ` +
            `(services: ${config.services.join(", ")}; plugins: ${allPlugins.map((p) => p.name).join(", ") || "none"})`,
        );
      }
    }
    onlyServices = svc;
    plugins = allPlugins.filter((p) => plg.has(p.name));
  }
  const services = resolveServices(config, onlyServices);
  if (opts.buildOnly && !opts.imageLabel) throw new CliError(`--build-only requires --image-label <label>`);
  if (opts.imageRepoPrefix && !opts.imageLabel)
    throw new CliError(`--image-repo-prefix requires --image-label <label>`);
  const imageSource = imageSourceFor(ctx, opts);
  const timing = createTimingRecorder(ctx.appPrefix);

  try {
    let imageMode = "";
    if (imageSource?.kind === "tagged") {
      imageMode = `, image registry.fly.io/${imageSource.appPrefix}-<service>:${imageSource.label}`;
    } else if (imageSource?.kind === "current") {
      imageMode = `, image-from ${imageSource.appPrefix}`;
    }
    let runMode = "";
    if (opts.dryRun) runMode = ", plan";
    else if (opts.buildOnly) runMode = ", build-only";
    header(`qm up — ${ctx.appPrefix} (target: fly${runMode}${imageMode})`);

    if (!opts.dryRun) {
      for (const s of services)
        timing.time(s, "app ensure", () => ensureApp(`${ctx.appPrefix}-${s}`, ctx.flyOrg, ctx.orgId, ctx.appPrefix));
      for (const p of plugins)
        timing.time(p.name, "app ensure", () =>
          ensureApp(pluginApp(ctx, p.name), ctx.flyOrg, ctx.orgId, ctx.appPrefix),
        );
      if (!opts.buildOnly && services.includes("core")) {
        timing.time("core", "object storage ensure", () => ensureObjectStorage(ctx));
      }
    }

    if (opts.buildOnly) {
      for (const s of services) {
        const path = writeDerived(ctx, s);
        note(`\n=== ${ctx.appPrefix}-${s} ===`);
        note(`config: ${path}`);
      }
      const sourcePlugins = plugins.filter((p) => p.kind === "source");
      for (const p of plugins) {
        const path = writePluginDerived(ctx, p);
        note(`\n=== ${pluginApp(ctx, p.name)} (plugin: ${p.kind}) ===`);
        note(p.kind === "source" ? `config: ${path}` : `config: ${path} (image ${p.image} pulled at deploy)`);
      }
      if (opts.dryRun) {
        note("\n" + bold("Plan only. Re-run without --dry-run to build images."));
        return;
      }
      await buildImages(ctx, services, opts.imageLabel!, timing);
      for (const p of sourcePlugins) await buildPluginImage(ctx, p, opts.imageLabel!, timing);
      note("");
      ok(`deployment images for ${ctx.appPrefix} built.`);
      return;
    }

    const gateSecrets = (app: string, header: string, path: string, required: string[], timingKey: string): boolean => {
      const existing = timing.time(timingKey, "secret checks", () => secretNames(app)) ?? new Set<string>();
      const missing = required.filter((sec) => !existing.has(sec));
      note(`\n=== ${header} ===`);
      note(`config: ${path}`);
      if (missing.length) {
        note(
          `MISSING secrets — set them with:\n  fly secrets set -a ${app} --stage ${missing.map((sec) => `${sec}=…`).join(" ")}`,
        );
      } else {
        note("secrets: ok");
      }
      return missing.length > 0;
    };

    let missingAny = false;
    for (const s of services) {
      const app = `${ctx.appPrefix}-${s}`;
      const required = [
        ...secretsForService(config, s)
          .filter((secret) => secret.required)
          .flatMap((secret) => runtimeSecretNames(s, secret)),
        ...flyProviderSecrets(config, s),
      ];
      if (gateSecrets(app, app, writeDerived(ctx, s), required, s)) missingAny = true;
    }
    for (const p of plugins) {
      const app = pluginApp(ctx, p.name);
      const required = secretsForService(config, p.name, [p.name])
        .filter((secret) => secret.required)
        .flatMap((secret) => runtimeSecretNames(p.name, secret, [p.name]));
      if (gateSecrets(app, `${app} (plugin: ${p.kind})`, writePluginDerived(ctx, p), required, p.name)) {
        missingAny = true;
      }
    }

    if (opts.dryRun) {
      note("\n" + bold("Plan only. Re-run without --dry-run to deploy."));
      return;
    }
    if (missingAny) {
      die("\naborting `up`: set the missing secrets above first (use --stage, the deploy applies them)");
    }
    if (services.includes("core")) {
      unsetDisabledSecurityScreenToken(config, ctx.appPrefix);
      unsetDisabledFlyPublisherToken(config, ctx.appPrefix);
    }

    for (const phase of flyDeployPhases(services)) await deployPhase(ctx, phase, imageSource, timing);
    await deployPlugins(ctx, plugins, imageSource, timing);
    if (ctx.sourceRoot) recordServiceImages(ctx, services, opts.configPath);

    note("");
    ok(`deployment ${ctx.appPrefix} deployed.`);
    note(`   Web UI: ${config.publicUrl.replace(/\/$/, "")}`);
    note(`   Health check: ${config.publicUrl.replace(/\/$/, "")}/healthz`);
    note(`   Slack app links: qm outputs`);
  } finally {
    appendGithubTimingSummary(timing.rows);
  }
}

interface FlyAppDiscovery {
  apps: string[];
  unverified: { app: string; reason: string }[];
}

function listRunningApps(
  appPrefix: string,
  deployAppPrefix: string,
  flyOrg: string,
  orgId: string,
  configured: Set<string>,
): FlyAppDiscovery {
  const names = flyOrgApps(flyOrg);
  const apps: string[] = [];
  const unverified: FlyAppDiscovery["unverified"] = [];
  const expectedId = flyDeploymentId(flyOrg, orgId, appPrefix);
  const marker = flyOwnershipMarker(flyOrg, orgId, appPrefix);
  const inspect = (name: string): { owned: boolean; reason?: string } => {
    let markerFailure = "";
    try {
      if (secretNames(name)?.has(marker)) return { owned: true };
    } catch (error) {
      markerFailure = errMessage(error);
    }
    try {
      const parsed = JSON.parse(fly(["status", "-a", name, "--json"])) as { Machines?: unknown };
      const machines = parsed.Machines;
      const owned =
        Array.isArray(machines) &&
        machines.some((machine) => {
          if (!machine || typeof machine !== "object") return false;
          const config = (machine as { config?: unknown }).config;
          if (!config || typeof config !== "object") return false;
          const env = (config as { env?: unknown }).env;
          return (
            !!env && typeof env === "object" && (env as Record<string, unknown>)[FLY_DEPLOYMENT_ID_ENV] === expectedId
          );
        });
      return owned
        ? { owned: true }
        : { owned: false, reason: `missing deployment marker ${marker} and live identity ${expectedId}` };
    } catch (error) {
      const statusFailure = errMessage(error);
      return {
        owned: false,
        reason: markerFailure
          ? `marker check failed (${markerFailure}); live identity check failed (${statusFailure})`
          : `live identity check failed (${statusFailure})`,
      };
    }
  };
  for (const name of configured) {
    if (!names.has(name)) {
      unverified.push({ app: name, reason: `not present in configured Fly organization ${flyOrg}` });
      continue;
    }
    const result = inspect(name);
    if (result.owned) apps.push(name);
    else unverified.push({ app: name, reason: result.reason ?? "ownership could not be verified" });
  }
  for (const name of names) {
    if (configured.has(name) || !name.startsWith(`${appPrefix}-`) || name.startsWith(`${deployAppPrefix}-`)) continue;
    const result = inspect(name);
    if (result.owned) apps.push(name);
    else if (result.reason?.includes("failed")) unverified.push({ app: name, reason: result.reason });
  }
  return { apps, unverified };
}

function discoverFlyApps(config: QmConfig, configDir: string): FlyAppDiscovery {
  const appPrefix = appPrefixOf(config);
  const deployAppPrefix = config.deployAppPrefix ?? `${appPrefix}-d`;
  const services = resolveServices(config).map((s) => `${appPrefix}-${s}`);
  const plugins = discoverPlugins(configDir, config).plugins.map((p) => `${appPrefix}-${p.name}`);
  const configured = new Set([...services, ...plugins]);
  let runtime: FlyAppDiscovery = { apps: [], unverified: [] };
  if (which(flyBin())) {
    try {
      runtime = listRunningApps(appPrefix, deployAppPrefix, config.flyOrg ?? "", config.orgId, configured);
    } catch (e) {
      runtime.unverified.push({ app: `${appPrefix}-*`, reason: errMessage(e) });
    }
  }
  return which(flyBin())
    ? { apps: [...new Set(runtime.apps)], unverified: runtime.unverified }
    : { apps: [...new Set([...services, ...plugins])], unverified: runtime.unverified };
}

function flyAppNames(config: QmConfig, configDir: string): string[] {
  const discovery = discoverFlyApps(config, configDir);
  for (const item of discovery.unverified)
    warn(`skipping ${item.app}: could not verify deployment ownership (${item.reason})`);
  return discovery.apps;
}

function flyInherit(args: string[]): void {
  try {
    execFileSync(flyBin(), args, { stdio: "inherit" });
  } catch {
    throw new CliError(`fly ${args.join(" ")} failed.`);
  }
}

export function flyStatus(config: QmConfig, configDir: string): void {
  const apps = flyAppNames(config, configDir);
  header(`qm status — ${appPrefixOf(config)} (target: fly)`);
  if (!which(flyBin())) {
    note(`flyctl not found — run:`);
    for (const app of apps) note(`  ${flyBin()} status -a ${app}`);
    return;
  }
  for (const app of apps) {
    note(`\n=== ${app} ===`);
    try {
      flyInherit(["status", "-a", app]);
    } catch (e) {
      note(errMessage(e));
    }
  }
  if (config.services.includes("slack")) note("slack: virtual service running in the core app");
}

export function flyLogs(
  config: QmConfig,
  configDir: string,
  service: string | undefined,
  opts: LogOpts = {},
): void | Promise<void> {
  const appPrefix = appPrefixOf(config);
  if (opts.tail !== undefined)
    note(`(--tail is a docker-only line count; flyctl logs has none, so it's ignored on the fly target)`);
  const logArgs = (app: string): string[] => ["logs", "-a", app, ...(opts.follow ? [] : ["--no-tail"])];

  if (service) {
    const resolved = service === "slack" ? "core" : service;
    if (service === "slack") note("slack is a virtual service; showing core logs");
    const app = `${appPrefix}-${resolved}`;
    if (!which(flyBin())) {
      note(`flyctl not found — run:\n  ${flyBin()} ${logArgs(app).join(" ")}`);
      return;
    }
    flyInherit(logArgs(app));
    return;
  }

  const apps = flyAppNames(config, configDir);
  if (!which(flyBin())) {
    note(`flyctl not found — run:`);
    for (const app of apps) note(`  ${flyBin()} ${logArgs(app).join(" ")}`);
    return;
  }
  return streamLabeled(
    apps.map((app) => ({ label: app.slice(appPrefix.length + 1), command: flyBin(), args: logArgs(app) })),
    (label, line) => note(`${dim(label)} | ${line}`),
  );
}

export function flyDown(config: QmConfig, configDir: string): void {
  const { apps, unverified } = discoverFlyApps(config, configDir);
  header(`qm down — ${appPrefixOf(config)} (target: fly)`);
  note("stopping the deployment by scaling every app to 0 machines (reversible: re-run `qm up`).");
  if (!which(flyBin())) {
    note(`flyctl not found — run:`);
    for (const app of apps) note(`  ${flyBin()} scale count 0 -a ${app}`);
    note(`(to delete apps entirely: ${flyBin()} apps destroy <app>)`);
    throw new CliError(`down incomplete — flyctl is not installed, so no apps were scaled to 0`);
  }
  const failures: string[] = [];
  for (const app of apps) {
    step(`scaling ${app} to 0`);
    try {
      flyInherit(["scale", "count", "0", "-a", app, "--yes"]);
    } catch (e) {
      failures.push(`${app}: ${errMessage(e)}`);
    }
  }
  if (unverified.length) {
    const details = unverified.map((item) => `  - ${item.app}: ${item.reason}`).join("\n");
    const scaleDetails = failures.length
      ? `\nfailed to scale ${failures.length} known app${failures.length === 1 ? "" : "s"}:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`
      : "";
    throw new CliError(
      `down incomplete — could not verify deployment ownership for ${unverified.length} app${unverified.length === 1 ? "" : "s"}; left untouched:\n${details}${scaleDetails}`,
    );
  }
  if (failures.length) {
    throw new CliError(
      `down incomplete — failed to scale ${failures.length} app${failures.length === 1 ? "" : "s"} to 0:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`,
    );
  }
  ok("down — all apps scaled to 0.");
}

export function flyPinSandbox(config: QmConfig, image: string, configDir = process.cwd()): void {
  const appPrefix = appPrefixOf(config);
  const app = `${appPrefix}-core`;
  const flyOrg = config.flyOrg ?? "";
  if (!flyOrgApps(flyOrg).has(app)) {
    note(
      `${app} is not deployed in Fly organization ${flyOrg} — no live core to roll; the pin only takes effect from the config's sandbox.image on the next \`qm up\``,
    );
    return;
  }
  assertOwnedApp(app, flyOrg, config.orgId, appPrefix);
  let running: string;
  try {
    running = currentImage(app);
  } catch {
    note(
      `${app} is not running — no live core to roll; the pin only takes effect from the config's sandbox.image on the next \`qm up\``,
    );
    return;
  }
  const pinned: QmConfig = { ...config, sandbox: { ...config.sandbox, image } };
  const cfgPath = writeDerived(buildCtx(pinned, configDir, {}), "core");
  if (secretNames(app)?.has("FLY_BASE_IMAGE")) {
    fly(["secrets", "unset", "--stage", "-a", app, "FLY_BASE_IMAGE"]);
    note(`removed the stale FLY_BASE_IMAGE secret on ${app}; the derived [env] pin is authoritative`);
  }
  fly(["deploy", "--yes", "-c", cfgPath, "--image", running, ...serviceDef("core").fly!.deployFlags]);
  ok(`${app} now boots sandboxes from ${image}`);
}

export function flyRollback(config: QmConfig, configPath: string, to?: string): void {
  if (!to) throw new CliError("Fly rollback requires --to <sandbox-sha-or-image>");
  if (to.startsWith("sha256:") && !/^sha256:[a-f0-9]{64}$/.test(to)) {
    throw new CliError(`rollback --to must resolve to an image tag or sha256 digest (got ${JSON.stringify(to)})`);
  }
  let image: string;
  if (to.includes("/")) {
    image = to;
  } else {
    let repository: string | undefined;
    if (config.sandbox?.image) repository = imageRepository(config.sandbox.image);
    else if (config.sandbox?.app) repository = flySandboxRepository(config.sandbox.app);
    if (!repository) {
      throw new CliError(
        "rollback cannot derive an image repository: the config has no sandbox.app or sandbox.image — " +
          "pass a full ref instead (--to <registry/repository@sha256:…>)",
      );
    }
    image = to.startsWith("sha256:") ? `${repository}@${to}` : `${repository}:${to}`;
  }
  const digestRef = /^\S+@sha256:[a-f0-9]{64}$/;
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  const taggedRef = colon > slash && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image.slice(colon + 1));
  if (image.includes("@") ? !digestRef.test(image) : !taggedRef) {
    throw new CliError(`rollback --to must resolve to an image tag or sha256 digest (got ${JSON.stringify(image)})`);
  }
  const pinned = pinnedByDigest(image);
  recordSandboxPin(configPath, pinned);
  note(`recorded sandbox.image = ${pinned} in ${configPath}`);
  flyPinSandbox(config, pinned, dirname(configPath));
}

export async function flyDoctor(config: QmConfig, configDir: string, envFile?: string): Promise<void> {
  const discovered = discoverPlugins(configDir, config);
  if (discovered.errors.length)
    throw new CliError(`doctor failed:\n${discovered.errors.map((error) => `  - ${error}`).join("\n")}`);
  requireFlyAuth();
  const prefix = appPrefixOf(config);
  const pluginNames = discovered.plugins.map((plugin) => plugin.name);
  const failures: string[] = [];
  for (const workload of [...runnableServices(config.services), ...pluginNames]) {
    const app = `${prefix}-${workload}`;
    const existing = secretNames(app);
    if (!existing) {
      step(`${app}: not created yet — secret checks run after the first \`qm up\``);
      continue;
    }
    const declared = secretsForService(config, workload, pluginNames);
    const required = new Set([
      ...declared
        .filter((secret) => secret.required)
        .flatMap((secret) => runtimeSecretNames(workload, secret, pluginNames)),
      ...flyProviderSecrets(config, workload),
    ]);
    const missing = [...required].filter((name) => !existing.has(name));
    if (missing.length) failures.push(`${app}: missing ${missing.join(", ")}`);
    else step(`${app} required secrets: ok`);
    for (const secret of declared.filter((item) => !item.required)) {
      for (const name of runtimeSecretNames(workload, secret, pluginNames)) {
        if (existing.has(name)) step(`${app} optional secret ${name}: configured`);
        else warn(`${app} optional secret ${name}: not configured`);
      }
    }
  }
  if (failures.length) throw new CliError(`doctor failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  const localSecrets = localDoctorSecrets(configDir, envFile);
  verifyLocalFlyTokens(config, localSecrets);
  await doctorCommon(config, localSecrets, { configDir });
}

export function verifyLocalFlyTokens(config: QmConfig, secrets: ReadonlyMap<string, string>): void {
  const verify = (name: string, args: string[], purpose: string): void => {
    const token = deploymentSecretValue(name, secrets.get(name));
    if (!token) {
      warn(`${name} is not available locally — skipping its live authorization check`);
      return;
    }
    const result = spawnSync(flyBin(), args, {
      encoding: "utf8",
      env: { ...process.env, FLY_API_TOKEN: token },
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (result.status !== 0) {
      throw new CliError(
        `${name} was rejected while checking ${purpose}; mint a fresh scoped token, run \`qm secrets push\`, and retry`,
      );
    }
    step(`${name}: live authorization ok`);
  };
  if (config.sandbox?.app) {
    verify("FLY_SANDBOX_API_TOKEN", ["machine", "list", "-a", config.sandbox.app, "--json"], config.sandbox.app);
  }
  if (config.flyOrg && config.env.core?.DEPLOY_PROVIDER === "fly") {
    verify("FLY_DEPLOY_API_TOKEN", ["apps", "list", "-o", config.flyOrg, "--json"], `organization ${config.flyOrg}`);
  }
}

export async function flyCheckLive(
  config: QmConfig,
  configDir: string,
  opts: { report?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const report = opts.report ?? true;
  requireFlyAuth();
  const discovered = discoverPlugins(configDir, config);
  if (discovered.errors.length) {
    throw new CliError(`live check failed:\n${discovered.errors.map((error) => `  - ${error}`).join("\n")}`, {
      clause: "fly.live-readiness",
    });
  }
  const ctx = buildCtx(config, configDir, {});
  const services = runnableServices(config.services);
  const firstParty = new Set<string>(services);
  const plugins = new Map(discovered.plugins.map((plugin) => [plugin.name, plugin]));
  const workloads = [...services, ...plugins.keys()];
  const orgApps = flyOrgApps(ctx.flyOrg);
  const expectedId = flyDeploymentId(ctx.flyOrg, ctx.orgId, ctx.appPrefix);
  const failures: string[] = [];
  let coreMachineId = "";
  for (const workload of workloads) {
    const app = `${ctx.appPrefix}-${workload}`;
    if (!orgApps.has(app)) {
      failures.push(`${app}: not present in configured Fly organization ${ctx.flyOrg}`);
      continue;
    }
    let parsed: {
      Machines?: Array<{
        id?: string;
        ID?: string;
        state?: string;
        region?: string;
        Region?: string;
        config?: { image?: string; env?: Record<string, unknown> };
      }>;
    };
    try {
      parsed = JSON.parse(fly(["status", "-a", app, "--json"])) as typeof parsed;
    } catch (error) {
      failures.push(`${app}: ${errMessage(error)}`);
      continue;
    }
    const machines = parsed.Machines ?? [];
    if (!machines.length) {
      failures.push(`${app}: no deployed machine`);
      continue;
    }
    const notStarted = machines.filter((machine) => machine.state !== "started");
    if (notStarted.length) {
      failures.push(
        `${app}: machine state is ${notStarted.map((machine) => machine.state ?? "unknown").join(", ")} instead of started`,
      );
      continue;
    }
    if (machines.some((machine) => !machine.config?.image)) {
      failures.push(`${app}: deployed machine has no image`);
      continue;
    }
    if (firstParty.has(workload)) {
      const configured = config.imageOverrides[workload as ServiceName];
      const packaged = configured ? undefined : manifestRef(workload as ServiceName);
      const expected = configured ?? (packaged?.includes("registry.invalid") ? undefined : packaged);
      const expectedDigest = expected?.match(/@(?<digest>sha256:[a-f0-9]{64})$/)?.groups?.["digest"];
      let imageDetails: FlyImageDetail[] = [];
      if (expectedDigest && machines.some((machine) => !machine.config?.image?.includes("@sha256:"))) {
        try {
          imageDetails = flyImageDetails(app);
        } catch (error) {
          failures.push(`${app}: ${errMessage(error)}`);
          continue;
        }
      }
      const wrongImage = expectedDigest
        ? machines.filter((machine) => {
            if (machine.config?.image?.endsWith(`@${expectedDigest}`)) return false;
            const machineId = machine.id ?? machine.ID;
            return !imageDetails.some((entry) => entry.machineId === machineId && entry.digest === expectedDigest);
          })
        : [];
      if (wrongImage.length) {
        failures.push(
          `${app}: ${wrongImage.length} machine${wrongImage.length === 1 ? "" : "s"} do not run configured image digest ${expectedDigest}`,
        );
        continue;
      }
    }
    const wrongIdentity = machines.filter((machine) => machine.config?.env?.[FLY_DEPLOYMENT_ID_ENV] !== expectedId);
    if (wrongIdentity.length) {
      failures.push(
        `${app}: ${wrongIdentity.length} machine${wrongIdentity.length === 1 ? "" : "s"} lack deployment identity ${expectedId}`,
      );
      continue;
    }
    const wrongRegion = machines.filter((machine) => (machine.region ?? machine.Region) !== ctx.region);
    if (wrongRegion.length) {
      failures.push(
        `${app}: machine region is ${wrongRegion.map((machine) => machine.region ?? machine.Region ?? "unknown").join(", ")} instead of ${ctx.region}`,
      );
      continue;
    }
    const plugin = plugins.get(workload);
    const expectedEnv = generatedTomlEnv(
      firstParty.has(workload)
        ? deriveToml(ctx, workload as ServiceName)
        : pluginTomlContent(
            ctx.appPrefix,
            ctx.flyOrg,
            ctx.orgId,
            config.publicUrl,
            config.services.includes("portal"),
            ctx.region,
            plugin!,
          ),
    );
    const envDrift = machines.flatMap((machine, index) =>
      Object.entries(expectedEnv).flatMap(([name, value]) =>
        machine.config?.env?.[name] === value ? [] : [`machine ${index + 1} env ${name}`],
      ),
    );
    if (envDrift.length) {
      failures.push(`${app}: rendered config drift (${envDrift.join(", ")})`);
      continue;
    }
    if (workload === "core") coreMachineId = machines[0]?.id ?? machines[0]?.ID ?? "";
    try {
      const rawChecks = JSON.parse(fly(["checks", "list", "-a", app, "--json"])) as unknown;
      if (!rawChecks || typeof rawChecks !== "object" || Array.isArray(rawChecks)) {
        failures.push(`${app}: health checks returned invalid JSON`);
        continue;
      }
      const checks = Object.values(rawChecks as Record<string, unknown>)
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .filter((value): value is Record<string, unknown> => !!value && typeof value === "object");
      if (!checks.length) {
        failures.push(`${app}: no health checks reported`);
        continue;
      }
      const unhealthy = checks.filter(
        (check) => String(check.status ?? check.Status ?? "").toLowerCase() !== "passing",
      );
      if (unhealthy.length) {
        failures.push(`${app}: ${unhealthy.length} health check${unhealthy.length === 1 ? "" : "s"} not passing`);
        continue;
      }
    } catch (error) {
      failures.push(`${app}: health checks unavailable: ${errMessage(error)}`);
      continue;
    }
    if (report)
      step(
        `${app}: ${machines.length} started, identity/config-matched, healthy machine${machines.length === 1 ? "" : "s"}`,
      );
  }

  const coreEnv = config.env.core ?? {};
  if (coreEnv.SNAPSHOT_STORE === "s3" || coreEnv.TRANSFER_STORE === "s3") {
    if (!coreMachineId) {
      failures.push(`${ctx.appPrefix}-core: cannot run the S3 durability probe without an identified machine`);
    } else {
      try {
        flyS3RoundTrip(`${ctx.appPrefix}-core`, coreMachineId);
        if (report) step(`${ctx.appPrefix}-core: S3 put/get/delete round trip passed`);
      } catch (error) {
        failures.push(`${ctx.appPrefix}-core: S3 put/get/delete probe failed: ${errMessage(error)}`);
      }
    }
  }

  const healthUrl = `${config.publicUrl.replace(/\/$/, "")}/healthz`;
  try {
    const response = await (opts.fetchImpl ?? fetch)(healthUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) failures.push(`${healthUrl}: HTTP ${response.status}`);
    else if (report) step(`${healthUrl}: HTTP ${response.status}`);
  } catch (error) {
    failures.push(`${healthUrl}: ${errMessage(error)}`);
  }
  if (!failures.length) {
    if (!coreMachineId) {
      failures.push(`${ctx.appPrefix}-core: cannot run the live session smoke without an identified machine`);
    } else {
      try {
        flyLiveSession(`${ctx.appPrefix}-core`, coreMachineId);
        if (report) step(`${ctx.appPrefix}-core: private live session smoke passed`);
      } catch (error) {
        failures.push(`${ctx.appPrefix}-core: private live session smoke failed: ${errMessage(error)}`);
      }
    }
  }
  if (failures.length) {
    throw new CliError(`live check failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`, {
      clause: "fly.live-readiness",
    });
  }
  if (report) ok("Fly live deployment check passed");
}

export async function flySecretsPush(config: QmConfig, configDir: string, envFile?: string): Promise<void> {
  const path = resolve(envFile ?? join(configDir, ".env"));
  const values = existsSync(path) ? readEnvFile(path) : new Map<string, string>();
  const prefix = appPrefixOf(config);
  const pluginNames = discoverPlugins(configDir, config).plugins.map((plugin) => plugin.name);
  const operatorSecrets = computedSecrets(config).filter((item) => item.managedBy === "operator");
  for (const secret of operatorSecrets) {
    const supplied = deploymentSecretValue(secret.name, values.get(secret.name));
    if (secret.required && supplied !== undefined && isInvalidSecret(secret.name, supplied)) {
      throw new CliError(`required secret ${secret.name} is missing, a placeholder, or too short`);
    }
  }
  const ctx = buildCtx(config, configDir, {});
  requireFlyAuth();
  for (const workload of runnableServices(config.services))
    ensureApp(`${prefix}-${workload}`, ctx.flyOrg, ctx.orgId, ctx.appPrefix);
  for (const plugin of pluginNames) ensureApp(`${prefix}-${plugin}`, ctx.flyOrg, ctx.orgId, ctx.appPrefix);
  unsetDisabledSecurityScreenToken(config, prefix);
  unsetDisabledFlyPublisherToken(config, prefix);
  const stagedApps = new Set<string>();
  for (const secret of operatorSecrets) {
    const supplied = deploymentSecretValue(secret.name, values.get(secret.name));
    if (!secret.required && !supplied) {
      step(`${secret.name}: optional, not supplied`);
      continue;
    }
    const value = supplied ?? (await promptHidden(secret.name));
    if (secret.required && isInvalidSecret(secret.name, value)) {
      throw new CliError(`required secret ${secret.name} is missing, a placeholder, or too short`);
    }
    const destinations = new Map<string, Set<string>>();
    for (const [workload, names] of secretDestinations(secret, pluginNames)) {
      destinations.set(`${prefix}-${workload}`, names);
    }
    for (const [app, names] of destinations) {
      stagedApps.add(app);
      for (const name of names) {
        stageSecret(app, name, value);
      }
    }
    step(`${secret.name}: staged on ${[...destinations].map(([app]) => app).join(", ")}`);
  }
  ok("operator secrets staged on Fly");
  const running = [...stagedApps].filter(appHasMachines);
  if (running.length) {
    warn(`staged secrets are NOT live yet on ${running.join(", ")}: running machines keep their old values`);
    warn("run `qm up` to apply them — a plain machine restart does not");
  }
}
