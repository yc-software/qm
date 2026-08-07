import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { appPrefixOf, dockerBasePort, type Target, type QmConfig } from "./config.ts";
import { CliError, errMessage, step, warn } from "./log.ts";
import { capture, deploymentSecretValue, flyBin, readEnvFile } from "./util.ts";

interface DeploymentLayerFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface DeploymentLayerBundle {
  contract: 1;
  tools: DeploymentLayerFile[];
  skills: DeploymentLayerFile[];
  data?: DeploymentLayerFile[];
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
    throw new CliError(`deployment layer API only accepts UTF-8 text assets: ${path}`);
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

function regularDirectoryExists(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new CliError(`deployment layer directory must be a regular directory: ${path}`);
  return true;
}

function walkText(root: string, prefix: string): DeploymentLayerFile[] {
  if (!regularDirectoryExists(root)) return [];
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
  if (!regularDirectoryExists(sandboxDir)) return { contract: 1, tools: [], skills: [] };
  const toolsDir = join(sandboxDir, "tools");
  const tools: DeploymentLayerFile[] = [];
  if (regularDirectoryExists(toolsDir)) {
    tools.push(
      ...readdirSync(toolsDir, { withFileTypes: true })
        .filter((entry) => !JUNK_FILE.test(entry.name))
        .map((entry) => {
          const path = join(toolsDir, entry.name);
          if (!entry.isDirectory())
            throw new CliError(`deployment layer tools entry must be a directory containing tool.json: ${path}`);
          const descriptor = join(path, "tool.json");
          if (!lstatSync(descriptor, { throwIfNoEntry: false }))
            throw new CliError(`deployment layer tool directory is missing tool.json: ${path}`);
          return textFile(toolsDir, descriptor, "tools");
        })
        .sort(pathOrder),
    );
  }
  const data = walkText(join(sandboxDir, "data"), "data");
  return {
    contract: 1,
    tools,
    skills: walkText(join(sandboxDir, "skills"), "skills"),
    ...(data.length ? { data } : {}),
  };
}

function normalizedLayerBody(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("deployment layer bundle must be an object");
  const bundle = value as Record<string, unknown>;
  if (
    bundle.contract !== 1 ||
    !Array.isArray(bundle.tools) ||
    !Array.isArray(bundle.skills) ||
    (bundle.data !== undefined && !Array.isArray(bundle.data))
  ) {
    throw new CliError("deployment layer bundle requires contract: 1, tools[], and skills[]");
  }
  const files = (kind: "tools" | "skills" | "data", entries: unknown[]): DeploymentLayerFile[] =>
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
  const data = files("data", (bundle.data as unknown[] | undefined) ?? []);
  return JSON.stringify({
    contract: 1,
    tools: files("tools", bundle.tools),
    skills: files("skills", bundle.skills),
    ...(data.length ? { data } : {}),
  });
}

export function deploymentLayerBody(sandboxDir: string): string {
  const bundle = deploymentLayerBundle(sandboxDir);
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

function coreUrl(config: QmConfig, target: Target): URL {
  if (target === "docker") return new URL(`http://127.0.0.1:${dockerBasePort(config)}/v1/deployment-layer`);
  const url = new URL(config.publicUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/deployment-layer`;
  return url;
}

class CoreUnreachableError extends CliError {}

const CONNECTIVITY_CODES = new Set([
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

export async function deploymentLayerRequest(opts: {
  config: QmConfig;
  target: Target;
  configDir: string;
  method: "GET" | "PUT";
  body?: string;
  envFile?: string;
}): Promise<{ status: number; body: string }> {
  const body = opts.body ?? "";
  if (opts.target === "fly") return flyRequest(opts.config, opts.method, body);
  const envPath = opts.envFile ?? join(opts.configDir, ".env");
  const env = existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
  let secret = deploymentSecretValue("CORE_SIGNING_SECRET", env.get("CORE_SIGNING_SECRET"));
  if (!secret && opts.target === "aws" && opts.config.aws) {
    secret = capture(process.env.AWS_BIN ?? "aws", [
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      `${opts.config.aws.secretsPrefix}CORE_SIGNING_SECRET`,
      "--query",
      "SecretString",
      "--output",
      "text",
      "--region",
      opts.config.aws.region,
    ]).trim();
  }
  if (!secret) throw new CliError(`CORE_SIGNING_SECRET is required locally to access the deployment layer`);
  const url = coreUrl(opts.config, opts.target);
  const response = await fetch(url, {
    method: opts.method,
    headers: signingHeaders(secret, opts.method, url.pathname + url.search, body),
    ...(opts.method === "PUT" ? { body } : {}),
    ...(opts.target === "aws" ? { signal: AbortSignal.timeout(60_000) } : {}),
  });
  return { status: response.status, body: await response.text() };
}

export async function syncDeploymentLayer(opts: {
  config: QmConfig;
  target: Target;
  configDir: string;
  sandboxDir: string;
  envFile?: string;
  allowUnavailable?: boolean;
}): Promise<void> {
  if (!regularDirectoryExists(opts.sandboxDir)) {
    step(`deployment layer: skipped (no sandbox directory at ${opts.sandboxDir})`);
    return;
  }
  const body = deploymentLayerBody(opts.sandboxDir);
  await syncDeploymentLayerBody(opts, body);
}

export async function currentDeploymentLayerState(opts: {
  config: QmConfig;
  target: Target;
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
    target: Target;
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
      target: opts.target,
      configDir: opts.configDir,
      method: "PUT",
      body,
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
