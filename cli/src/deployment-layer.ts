import { createHash, createHmac } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { QmConfig } from "./config.ts";
import { CliError, errMessage, step, warn } from "./log.ts";
import { deploymentSecretValue, readEnvFile } from "./util.ts";

interface DeploymentLayerFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface DeploymentLayerBundle {
  contract: 1;
  tools: DeploymentLayerFile[];
  skills: DeploymentLayerFile[];
}

export interface DeploymentLayerState {
  body: string;
  contentHash: string;
  status: "applied" | "degraded";
  runtimeContentHash: string | null;
  bootstrapped: boolean;
}

export interface DeploymentLayerSyncResult {
  version?: number;
  contentHash?: string;
  durable?: boolean;
  status?: "applied" | "degraded";
  message?: string;
}

function textFile(root: string, path: string, prefix: string): DeploymentLayerFile {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new CliError(`deployment layer file must be a regular file: ${path}`);
  const bytes = readFileSync(path);
  if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    throw new CliError(`deployment layer API only accepts text skill assets: ${path}`);
  }
  const rel = relative(root, path).split(sep).join("/");
  return {
    path: `${prefix}/${rel}`,
    content: bytes.toString("utf8"),
    ...((stat.mode & 0o111) !== 0 ? { executable: true } : {}),
  };
}

const pathOrder = (a: DeploymentLayerFile, b: DeploymentLayerFile): number => {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
};

export const JUNK_FILE = /^(?:\.DS_Store|Thumbs\.db|\._.*)$/;

function walkText(root: string, prefix: string): DeploymentLayerFile[] {
  if (!existsSync(root)) return [];
  const out: DeploymentLayerFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (JUNK_FILE.test(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(textFile(root, path, prefix));
    }
  };
  walk(root);
  return out.sort(pathOrder);
}

export function deploymentLayerBundle(sandboxDir: string): DeploymentLayerBundle {
  const toolsDir = join(sandboxDir, "tools");
  const tools = existsSync(toolsDir)
    ? readdirSync(toolsDir, { withFileTypes: true })
        .filter((entry) => !JUNK_FILE.test(entry.name))
        .map((entry) => {
          const path = join(toolsDir, entry.name);
          if (!entry.isDirectory())
            throw new CliError(`deployment layer tools entry must be a directory containing tool.json: ${path}`);
          const descriptor = join(path, "tool.json");
          if (!existsSync(descriptor))
            throw new CliError(`deployment layer tool directory is missing tool.json: ${path}`);
          return textFile(toolsDir, descriptor, "tools");
        })
        .sort(pathOrder)
    : [];
  return { contract: 1, tools, skills: walkText(join(sandboxDir, "skills"), "skills") };
}

function normalizedLayerBody(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("deployment layer bundle must be an object");
  const bundle = value as Record<string, unknown>;
  if (bundle.contract !== 1 || !Array.isArray(bundle.tools) || !Array.isArray(bundle.skills)) {
    throw new CliError("deployment layer bundle requires contract: 1, tools[], and skills[]");
  }
  const files = (kind: "tools" | "skills", entries: unknown[]): DeploymentLayerFile[] =>
    entries
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          throw new CliError(`deployment layer ${kind} entry must be an object`);
        const file = entry as Record<string, unknown>;
        if (typeof file.path !== "string" || typeof file.content !== "string") {
          throw new CliError(`deployment layer ${kind} entries require string path and content`);
        }
        return { path: file.path, content: file.content, ...(file.executable === true ? { executable: true } : {}) };
      })
      .sort(pathOrder);
  return JSON.stringify({ contract: 1, tools: files("tools", bundle.tools), skills: files("skills", bundle.skills) });
}

export function deploymentLayerBody(sandboxDir: string): string {
  const bundle = existsSync(sandboxDir)
    ? deploymentLayerBundle(sandboxDir)
    : { contract: 1 as const, tools: [], skills: [] };
  const body = normalizedLayerBody(bundle);
  if (Buffer.byteLength(body) > 1_000_000)
    throw new CliError("deployment layer exceeds the core API's 1 MB request limit");
  return body;
}

function signingHeaders(secret: string, method: string, path: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${path}\n${body}`;
  const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${canonical}`).digest("hex");
  return {
    "content-type": "application/json",
    "x-timestamp": String(timestamp),
    "x-signature": `v0=${signature}`,
  };
}

function defaultCoreUrl(config: QmConfig): URL {
  const url = new URL(config.publicUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/deployment-layer`;
  return url;
}

export class CoreUnreachableError extends CliError {}

export const CONNECTIVITY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPERM",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isCoreUnreachable(error: unknown): boolean {
  if (error instanceof CoreUnreachableError) return true;
  if (error instanceof CliError) return false;
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CONNECTIVITY_CODES.has(code)) return true;
  }
  return false;
}

interface DeploymentLayerTransportOpts {
  config: QmConfig;
  configDir: string;
  method: "GET" | "PUT";
  body: string;
  envFile?: string;
}

/**
 * How a hosting target reaches its core's /v1/deployment-layer endpoint.
 * Each HostingProvider supplies one; nothing in this file knows about targets.
 */
export type DeploymentLayerTransport = (
  opts: DeploymentLayerTransportOpts,
) => Promise<{ status: number; body: string }>;

/** Signed-HTTP transport used by providers whose core is reachable over plain HTTPS. */
export function httpDeploymentLayerTransport(
  o: {
    urlOf?: (config: QmConfig) => URL;
    secretFallback?: (config: QmConfig) => string | undefined;
    timeoutMs?: number;
  } = {},
): DeploymentLayerTransport {
  return async (opts) => {
    const envPath = opts.envFile ?? join(opts.configDir, ".env");
    const env = existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
    let secret = deploymentSecretValue("CORE_SIGNING_SECRET", env.get("CORE_SIGNING_SECRET"));
    if (!secret && o.secretFallback) secret = o.secretFallback(opts.config);
    if (!secret) throw new CliError(`CORE_SIGNING_SECRET is required locally to access the deployment layer`);
    const url = (o.urlOf ?? defaultCoreUrl)(opts.config);
    const response = await fetch(url, {
      method: opts.method,
      headers: signingHeaders(secret, opts.method, url.pathname + url.search, opts.body),
      ...(opts.method === "PUT" ? { body: opts.body } : {}),
      ...(o.timeoutMs ? { signal: AbortSignal.timeout(o.timeoutMs) } : {}),
    });
    return { status: response.status, body: await response.text() };
  };
}

export async function deploymentLayerRequest(opts: {
  config: QmConfig;
  configDir: string;
  method: "GET" | "PUT";
  body?: string;
  envFile?: string;
  transport: DeploymentLayerTransport;
}): Promise<{ status: number; body: string }> {
  return opts.transport({
    config: opts.config,
    configDir: opts.configDir,
    method: opts.method,
    body: opts.body ?? "",
    ...(opts.envFile ? { envFile: opts.envFile } : {}),
  });
}

export async function syncDeploymentLayer(opts: {
  config: QmConfig;
  transport: DeploymentLayerTransport;
  configDir: string;
  sandboxDir: string;
  envFile?: string;
  allowUnavailable?: boolean;
}): Promise<void> {
  if (!existsSync(opts.sandboxDir)) {
    step(`deployment layer: skipped (no sandbox directory at ${opts.sandboxDir})`);
    return;
  }
  const body = deploymentLayerBody(opts.sandboxDir);
  await syncDeploymentLayerBody(opts, body);
}

export async function currentDeploymentLayerState(opts: {
  config: QmConfig;
  transport: DeploymentLayerTransport;
  configDir: string;
  envFile?: string;
}): Promise<DeploymentLayerState> {
  const response = await deploymentLayerRequest({ ...opts, method: "GET" });
  if (response.status < 200 || response.status >= 300)
    throw new CliError(`deployment layer read failed (${response.status}): ${response.body}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new CliError("deployment layer read returned unparseable JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError("deployment layer read returned invalid JSON");
  const result = parsed as Record<string, unknown>;
  let bundle = result.bundle;
  const noDurableRecord = result.source === "none" || (result.contentHash === null && result.version === 0);
  let bootstrapped = false;
  if ((!bundle || typeof bundle !== "object" || Array.isArray(bundle)) && noDurableRecord) {
    bundle = { contract: 1, tools: [], skills: [] };
    bootstrapped = true;
  }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
    throw new CliError("deployment layer read did not return a restorable bundle");
  const body = normalizedLayerBody(bundle);
  if (Buffer.byteLength(body) > 1_000_000)
    throw new CliError("deployment layer exceeds the core API's 1 MB request limit");
  const contentHash = createHash("sha256").update(body).digest("hex");
  if (result.contentHash !== null && result.contentHash !== undefined && result.contentHash !== contentHash) {
    throw new CliError("deployment layer read returned a bundle that does not match its contentHash");
  }
  const status = result.status === "degraded" ? "degraded" : "applied";
  let runtimeContentHash = null;
  if (typeof result.runtimeContentHash === "string") runtimeContentHash = result.runtimeContentHash;
  else if (result.source === "none") runtimeContentHash = contentHash;
  return { body, contentHash, status, runtimeContentHash, bootstrapped };
}

export async function syncDeploymentLayerBody(
  opts: {
    config: QmConfig;
    transport: DeploymentLayerTransport;
    configDir: string;
    envFile?: string;
    allowUnavailable?: boolean;
  },
  body: string,
): Promise<DeploymentLayerSyncResult | undefined> {
  let response: { status: number; body: string };
  try {
    response = await deploymentLayerRequest({
      config: opts.config,
      configDir: opts.configDir,
      method: "PUT",
      body,
      transport: opts.transport,
      ...(opts.envFile ? { envFile: opts.envFile } : {}),
    });
  } catch (error) {
    if (opts.allowUnavailable && isCoreUnreachable(error)) {
      step(`deployment layer: core is not reachable; deployment succeeded and sync is deferred until the next up`);
      return;
    }
    throw new CliError(`could not sync deployment layer: ${errMessage(error)}`);
  }
  if (response.status < 200 || response.status >= 300)
    throw new CliError(`deployment layer sync failed (${response.status}): ${response.body}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new CliError(
      `deployment layer sync returned a ${response.status} but unparseable JSON: ${response.body.slice(0, 200)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`deployment layer sync returned invalid JSON: expected an object`);
  }
  const result = parsed as Record<string, unknown>;
  if (result.contentHash !== undefined && typeof result.contentHash !== "string") {
    throw new CliError(`deployment layer sync returned invalid JSON: contentHash must be a string`);
  }
  if (result.version !== undefined && typeof result.version !== "number") {
    throw new CliError(`deployment layer sync returned invalid JSON: version must be a number`);
  }
  if (result.durable !== undefined && typeof result.durable !== "boolean") {
    throw new CliError(`deployment layer sync returned invalid JSON: durable must be a boolean`);
  }
  if (result.status !== undefined && result.status !== "applied" && result.status !== "degraded") {
    throw new CliError(`deployment layer sync returned invalid JSON: status must be applied or degraded`);
  }
  if (result.message !== undefined && typeof result.message !== "string") {
    throw new CliError(`deployment layer sync returned invalid JSON: message must be a string`);
  }
  step(`deployment layer: v${result.version ?? "?"} ${result.contentHash?.slice(0, 12) ?? "empty"}`);
  if (result.status === "degraded") {
    warn(
      `deployment layer persisted but only partially applied: ${result.message ?? "the core is serving its previous resolved layer"}`,
    );
  }
  if (result.durable === false) {
    warn(
      "deployment layer is memory-backed and will not survive a core restart; configure DATABASE_URL for durable storage",
    );
  }
  return result as DeploymentLayerSyncResult;
}
