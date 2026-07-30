import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CliError, die, errMessage } from "./log.ts";
import {
  AUTH_BROKER_ENV_KEYS,
  SERVICE_NAMES,
  VIRTUAL_SERVICE_NAMES,
  isDeclaredService,
  isServiceName,
  pluginNameError,
  runnableServices,
  serviceDef,
  type DeclaredServiceName,
  type ServiceName,
} from "./services.ts";
import { hostingProviderChoices, isTarget, type Target } from "./providers.ts";
import { envNum, isEnvVarName, isMissingOrPlaceholder } from "./util.ts";

export const CONFIG_FILENAME = "qm.config.jsonc";

export const CONTRACT_VERSION = 1 as const;

export const validOrgId = (value: string): boolean =>
  value.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value);

export type { Target } from "./providers.ts";

export interface PluginSecret {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PluginEntry {
  name: string;
  image?: string;
  env?: Record<string, string>;
  secrets?: PluginSecret[];
}

export interface SandboxConfig {
  backend?: "sprites" | "aws";
  app?: string;
  image?: string;
  baseImage?: string;
  env?: Record<string, string>;
  secretEnv?: string[];
}

export interface SecurityScreenConfig {
  backend: "proxy";
  provider: string;
  endpoint: string;
  rollout: "shadow" | "enforce";
}

export interface AwsServiceConfig {
  ecrRepository: string;
  ecsService: string;
  cpu: number;
  memory: number;
  desiredCount?: number;
  architecture?: "arm64" | "amd64";
  taskRoleArn?: string;
  executionRoleArn?: string;
  buildArgs?: Record<string, string>;
  dockerfile?: string;
  targetGroup?: string;
  logGroup?: string;
  stopTimeout?: number;
}

export interface AwsConfig {
  accountId: string;
  region: string;
  cluster: string;
  deployRoleArn: string;
  secretsPrefix: string;
  imageLabel: string;
  alb?: string;
  rdsInstance?: string;
  predeployDbSnapshot?: boolean;
  dbRetentionMinDays?: number;
  deployBranch?: string;
  deployEnvironment?: string;
  objectStoreBucket?: string;
  networking: {
    cloudMapNamespace: string;
  };
  services: Record<string, AwsServiceConfig>;
}

export function awsWorkloadArchitecture(config: QmConfig, workload: string): "arm64" | "amd64" {
  const service = config.aws?.services[workload];
  if (!service) throw new CliError(`aws.services.${workload} is missing`);
  const externalImage =
    config.plugins.some((plugin) => plugin.name === workload && plugin.image) ||
    (isServiceName(workload) && Boolean(config.imageOverrides[workload]));
  if (!service.architecture && externalImage) {
    throw new CliError(
      `aws.services.${workload}.architecture is required because ${workload} uses an external prebuilt image`,
    );
  }
  return service.architecture ?? "arm64";
}

/**
 * The vendor supplying the deployment's base model. Selecting one makes that vendor's
 * API key a required deployment secret, so `qm setup` collects it and `qm up` refuses
 * to deploy a stack that cannot run a single agent turn. Leaving it unset preserves the
 * older flow, where an administrator supplies the key from the Admin page after deploy.
 */
export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The API key each provider's base model is billed against. */
export const MODEL_PROVIDER_KEYS: Readonly<Record<ModelProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export const isModelProvider = (value: unknown): value is ModelProvider =>
  typeof value === "string" && (MODEL_PROVIDERS as readonly string[]).includes(value);

export interface QmConfig {
  contract: typeof CONTRACT_VERSION;
  orgId: string;
  publicUrl: string;
  apiUrl?: string;
  target: Target;
  model?: string;
  modelProvider?: ModelProvider;
  basePort?: number;
  services: DeclaredServiceName[];
  plugins: PluginEntry[];
  skills: string[];
  env: Partial<Record<DeclaredServiceName, Record<string, string>>>;
  secretEnv?: Partial<Record<DeclaredServiceName, Record<string, string>>>;
  securityScreen?: SecurityScreenConfig;
  vms?: Partial<Record<ServiceName, { size?: string; memory?: string }>>;
  imageOverrides: Partial<Record<ServiceName, string>>;
  sandbox?: SandboxConfig;
  appPrefix?: string;
  region?: string;
  flyOrg?: string;
  imageFrom?: string;
  deployAppPrefix?: string;
  aws?: AwsConfig;
}

export function securityScreenEnv(config: Pick<QmConfig, "securityScreen">): Record<string, string> {
  const screen = config.securityScreen;
  if (!screen) return {};
  return {
    SECURITY_SCREEN_BACKEND: screen.backend,
    SECURITY_SCREEN_PROXY_PROVIDER: screen.provider,
    SECURITY_SCREEN_PROXY_ENDPOINT: screen.endpoint,
    SECURITY_SCREEN_PROXY_ROLLOUT: screen.rollout,
  };
}

export function configPathInDir(dir: string): string | undefined {
  const candidate = resolve(dir, CONFIG_FILENAME);
  return existsSync(candidate) ? candidate : undefined;
}

export function findConfigPath(start = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = configPathInDir(dir);
    if (candidate) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadConfigInDir(dir: string, overrides?: { target?: Target }): { config: QmConfig; path: string } {
  const path = configPathInDir(dir);
  if (!path) {
    die(`no ${CONFIG_FILENAME} in ${resolve(dir)} — run \`qm init\` there, or pass --config <path>.`);
  }
  return loadConfigAt(path, overrides);
}

export const appPrefixOf = (config: QmConfig): string => config.appPrefix ?? config.orgId;

export const dockerBasePort = (config: QmConfig): number => envNum("QM_BASE_PORT", config.basePort ?? 8080);

export const isDigestPinned = (ref: string): boolean => /@sha256:[0-9a-f]{64}$/.test(ref);

const SANDBOX_PIN_PENDING = `"sandbox.app" is set but no sandbox layer image is pinned; run \`qm sandbox publish\` to build and record the digest-pinned "sandbox.image" agents boot from`;

export const sandboxPinPending = (config: QmConfig): boolean =>
  config.target !== "aws" && Boolean(config.sandbox?.app && !config.sandbox.image);

export function sandboxImagePinErrors(config: QmConfig): Array<{ clause: string; message: string }> {
  const sb = config.sandbox;
  if (!sb?.app || !sb.image || isDigestPinned(sb.image)) return [];
  return [
    {
      clause: "config.v1",
      message: `"sandbox.image" must be pinned by digest (registry/repository@sha256:…) so a machine's image reference decides whether it is stale; got ${sb.image}`,
    },
  ];
}

export function sandboxCoreEnv(
  config: QmConfig,
  lookup?: (name: string) => string | undefined,
): { env: Record<string, string>; missingSecrets: string[] } {
  const env: Record<string, string> = {};
  const missingSecrets: string[] = [];
  const sb = config.sandbox;
  if (!sb) return { env, missingSecrets };
  if (sb.app) {
    if (!sb.image) throw new CliError(SANDBOX_PIN_PENDING, { clause: "config.v1" });
    const violation = sandboxImagePinErrors(config)[0];
    if (violation) throw new CliError(violation.message, { clause: violation.clause });
    env.FLY_SANDBOX_APP_NAME = sb.app;
    env.FLY_BASE_IMAGE = sb.image;
    const backend = sb.backend ?? (config.target === "fly" ? "sprites" : undefined);
    if (backend) env.SANDBOX_BACKEND = backend;
  }
  for (const [k, v] of Object.entries(sb.env ?? {})) env[`FLY_RESIDENT_ENV_${k}`] = v;
  for (const name of sb.secretEnv ?? []) {
    const v = lookup?.(name);
    if (v === undefined || v === "") missingSecrets.push(name);
    else env[`FLY_RESIDENT_ENV_${name}`] = v;
  }
  return { env, missingSecrets };
}

function stripJsonComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = scanString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === "/" && text[i + 1] === "/") {
      for (; i < text.length && text[i] !== "\n"; i++) out += " ";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = text;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '"') {
      i = scanString(out, i) - 1;
      continue;
    }
    if (out[i] !== ",") continue;
    const next = skipWs(out, i + 1);
    if (out[next] === "}" || out[next] === "]") out = out.slice(0, i) + " " + out.slice(i + 1);
  }
  return out;
}

const parseConfigJson = (text: string): unknown => JSON.parse(stripTrailingCommas(stripJsonComments(text)));

const skipWs = (s: string, i: number): number => {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
};

function scanString(s: string, i: number): number {
  for (i++; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i + 1;
  }
  throw new CliError("config has an unterminated string");
}

function scanValue(s: string, i: number): number {
  const ch = s[i]!;
  if (ch === '"') return scanString(s, i);
  if (ch === "{" || ch === "[") {
    const close = ch === "{" ? "}" : "]";
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i]!;
      if (c === '"') i = scanString(s, i) - 1;
      else if (c === ch) depth++;
      else if (c === close && --depth === 0) return i + 1;
    }
    throw new CliError(`config has an unbalanced ${ch}`);
  }
  while (i < s.length && !/[,}\]\s]/.test(s[i]!)) i++;
  return i;
}

interface PropSpan {
  key: string;
  valueStart: number;
  valueEnd: number;
}

function objectProps(s: string, objStart: number): { props: PropSpan[]; openBrace: number; closeBrace: number } {
  let i = skipWs(s, objStart);
  if (s[i] !== "{") throw new CliError("config value is not an object");
  const openBrace = i;
  i++;
  const props: PropSpan[] = [];
  for (;;) {
    i = skipWs(s, i);
    if (i >= s.length) throw new CliError("config object is not closed");
    if (s[i] === "}") return { props, openBrace, closeBrace: i };
    if (s[i] !== '"') throw new CliError("config object has a non-string key");
    const keyEnd = scanString(s, i);
    const key = JSON.parse(s.slice(i, keyEnd)) as string;
    i = skipWs(s, keyEnd);
    if (s[i] !== ":") throw new CliError(`config key ${JSON.stringify(key)} has no value`);
    i = skipWs(s, i + 1);
    const valueEnd = scanValue(s, i);
    props.push({ key, valueStart: i, valueEnd });
    i = skipWs(s, valueEnd);
    if (s[i] === ",") i++;
  }
}

function updateConfigStringMap(raw: string, key: string, updates: Record<string, string>): string {
  const stripped = stripJsonComments(raw);
  const root = objectProps(stripped, 0);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const entry = ([k, v]: [string, string]): string => `${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  const property = root.props.find((p) => p.key === key);
  if (property) {
    const obj = objectProps(stripped, property.valueStart);
    const missing: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(updates)) {
      const prop = obj.props.find((p) => p.key === k);
      if (prop) edits.push({ start: prop.valueStart, end: prop.valueEnd, text: JSON.stringify(v) });
      else missing.push([k, v]);
    }
    if (missing.length) {
      const body = missing.map(entry).join(", ");
      const text = obj.props.length ? ` ${body},` : ` ${body} `;
      edits.push({ start: obj.openBrace + 1, end: obj.openBrace + 1, text });
    }
  } else {
    const body = Object.entries(updates).map(entry).join(", ");
    const text = `${root.props.length ? "," : ""}\n  ${JSON.stringify(key)}: { ${body} }\n`;
    edits.push({ start: root.closeBrace, end: root.closeBrace, text });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = raw;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export const updateConfigSandbox = (raw: string, updates: Record<string, string>): string =>
  updateConfigStringMap(raw, "sandbox", updates);

export const updateConfigImageOverrides = (raw: string, updates: Record<string, string>): string =>
  updateConfigStringMap(raw, "imageOverrides", updates);

export function updateConfigCoreEnv(raw: string, updates: Record<string, string>): string {
  const stripped = stripJsonComments(raw);
  const root = objectProps(stripped, 0);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const envProp = root.props.find((p) => p.key === "env");
  if (!envProp) throw new CliError('config has no top-level "env" object');
  const env = objectProps(stripped, envProp.valueStart);
  const coreProp = env.props.find((p) => p.key === "core");
  if (!coreProp) throw new CliError('config has no "env.core" object');
  const core = objectProps(stripped, coreProp.valueStart);
  const missing: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(updates)) {
    const prop = core.props.find((p) => p.key === key);
    if (prop) edits.push({ start: prop.valueStart, end: prop.valueEnd, text: JSON.stringify(value) });
    else missing.push([key, value]);
  }
  if (missing.length) {
    const body = missing.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ");
    edits.push({
      start: core.openBrace + 1,
      end: core.openBrace + 1,
      text: core.props.length ? ` ${body},` : ` ${body} `,
    });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = raw;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

export function loadConfigAt(path: string, overrides?: { target?: Target }): { config: QmConfig; path: string } {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new CliError(`config file not found: ${path}`);
  let raw: unknown;
  try {
    raw = parseConfigJson(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new CliError(`${abs} is not valid JSON: ${errMessage(e)}`);
  }
  if (overrides?.target !== undefined) {
    if (!isPlainObject(raw)) throw new CliError(`${abs}: expected a JSON object`);
    raw = { ...raw, target: overrides.target };
  }
  return { config: validate(raw, abs), path: abs };
}

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function validateSecurityScreen(raw: unknown, path: string): SecurityScreenConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new CliError(`${path}: "securityScreen" must be an object`);
  const allowed = new Set(["backend", "provider", "endpoint", "rollout"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new CliError(`${path}: "securityScreen.${key}" is not recognized`);
  }
  if (raw.backend !== "proxy") throw new CliError(`${path}: "securityScreen.backend" must be "proxy"`);
  if (
    typeof raw.provider !== "string" ||
    raw.provider.length > 63 ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(raw.provider)
  ) {
    throw new CliError(`${path}: "securityScreen.provider" must be a lowercase DNS label`);
  }
  if (raw.provider === "surface" || raw.provider === "origin") {
    throw new CliError(`${path}: "securityScreen.provider" must not collide with a security screen metadata field`);
  }
  if (typeof raw.endpoint !== "string") {
    throw new CliError(`${path}: "securityScreen.endpoint" must be an HTTPS URL`);
  }
  try {
    const endpoint = new URL(raw.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.hostname.endsWith(".")
    ) {
      throw new Error("endpoint");
    }
  } catch {
    throw new CliError(
      `${path}: "securityScreen.endpoint" must be an HTTPS URL without credentials, a fragment, or a trailing hostname dot`,
    );
  }
  if (raw.rollout !== "shadow" && raw.rollout !== "enforce") {
    throw new CliError(`${path}: "securityScreen.rollout" must be "shadow" or "enforce"`);
  }
  return {
    backend: raw.backend,
    provider: raw.provider,
    endpoint: raw.endpoint,
    rollout: raw.rollout,
  };
}

export function readConfigOrgId(path: string): string | undefined {
  try {
    const raw = parseConfigJson(readFileSync(path, "utf8"));
    const orgId = isPlainObject(raw) ? raw.orgId : undefined;
    return typeof orgId === "string" && validOrgId(orgId) ? orgId : undefined;
  } catch {
    return undefined;
  }
}

function validate(raw: unknown, path: string): QmConfig {
  if (!isPlainObject(raw)) throw new CliError(`${path}: expected a JSON object`);
  const o = raw;

  const contract = o["contract"];
  if (contract !== CONTRACT_VERSION) {
    if (typeof contract === "number" && Number.isInteger(contract)) {
      throw new CliError(
        `${path}: unsupported contract major ${contract}; this CLI supports contract ${CONTRACT_VERSION}`,
      );
    }
    throw new CliError(`${path}: "contract" must be ${CONTRACT_VERSION}`);
  }

  const orgId = o["orgId"];
  if (typeof orgId !== "string" || !validOrgId(orgId)) {
    throw new CliError(`${path}: "orgId" must be a lowercase DNS label (a-z, 0-9, and hyphens between)`);
  }

  const publicUrl = o["publicUrl"];
  if (typeof publicUrl !== "string" || !publicUrl.trim()) {
    throw new CliError(`${path}: "publicUrl" must be a non-empty http(s) URL`);
  }
  try {
    const parsed = new URL(publicUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new CliError(`${path}: "publicUrl" must be a non-empty http(s) URL`);
  }

  const apiUrl = o["apiUrl"];
  if (apiUrl !== undefined) {
    if (typeof apiUrl !== "string" || !apiUrl.trim()) {
      throw new CliError(`${path}: "apiUrl" must be a non-empty http(s) origin URL`);
    }
    try {
      const parsed = new URL(apiUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
      if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password)
        throw new Error("origin");
      if (parsed.hostname.endsWith(".")) throw new Error("trailing dot");
    } catch {
      throw new CliError(
        `${path}: "apiUrl" must be a non-empty http(s) origin URL without credentials, a path, query, fragment, or trailing hostname dot`,
      );
    }
  }

  const target = o["target"];
  if (!isTarget(target)) throw new CliError(`${path}: "target" must be ${hostingProviderChoices()}`);

  const servicesRaw = o["services"];
  if (!Array.isArray(servicesRaw)) throw new CliError(`${path}: "services" must be an array`);
  const services: DeclaredServiceName[] = [];
  for (const s of servicesRaw) {
    if (typeof s !== "string" || !isDeclaredService(s)) {
      throw new CliError(
        `${path}: unknown service ${JSON.stringify(s)} — valid: ${[...SERVICE_NAMES, ...VIRTUAL_SERVICE_NAMES].join(", ")}`,
      );
    }
    if (!services.includes(s)) services.push(s);
  }
  if (!services.includes("core")) throw new CliError(`${path}: "services" must include "core"`);
  if (services.includes("auth") && !services.includes("portal")) {
    throw new CliError(
      `${path}: the "auth" sign-in broker requires "portal" — the portal is the only service that publishes it`,
    );
  }

  const plugins = validatePlugins(o["plugins"], path);
  const skills = validateStringArray(o["skills"], path, "skills");
  const env = validateServiceMap(o["env"], path, "env", (v, k) => validateStringMap(v, path, `env.${k}`));
  const secretEnv = validateServiceMap(o["secretEnv"], path, "secretEnv", (v, k) => {
    const entries = validateStringMap(v, path, `secretEnv.${k}`);
    for (const [envName, storeName] of Object.entries(entries)) {
      if (!isEnvVarName(envName))
        throw new CliError(`${path}: "secretEnv.${k}" key ${JSON.stringify(envName)} is not a valid env var name`);
      if (!isEnvVarName(storeName))
        throw new CliError(
          `${path}: "secretEnv.${k}.${envName}" must name a secret-store entry (a valid env-var-shaped name)`,
        );
    }
    return entries;
  });
  const securityScreen = validateSecurityScreen(o["securityScreen"], path);
  const managedSecurityScreenEnv = [
    "SECURITY_SCREEN_BACKEND",
    "SECURITY_SCREEN_PROXY_PROVIDER",
    "SECURITY_SCREEN_PROXY_ENDPOINT",
    "SECURITY_SCREEN_PROXY_ROLLOUT",
  ];
  for (const [service, values] of Object.entries(env)) {
    for (const name of [...managedSecurityScreenEnv, "SECURITY_SCREEN_PROXY_TOKEN"]) {
      if (values?.[name] !== undefined) {
        throw new CliError(`${path}: "env.${service}.${name}" is managed by securityScreen and cannot be overridden`);
      }
    }
  }
  for (const [service, values] of Object.entries(secretEnv)) {
    for (const name of managedSecurityScreenEnv) {
      if (values?.[name] !== undefined) {
        throw new CliError(
          `${path}: "secretEnv.${service}.${name}" is managed by securityScreen and cannot be overridden`,
        );
      }
    }
    if (service !== "core" && values?.SECURITY_SCREEN_PROXY_TOKEN !== undefined) {
      throw new CliError(`${path}: SECURITY_SCREEN_PROXY_TOKEN may be routed only to core`);
    }
  }
  if (securityScreen && secretEnv.core?.SECURITY_SCREEN_PROXY_TOKEN === undefined) {
    throw new CliError(`${path}: securityScreen requires secretEnv.core.SECURITY_SCREEN_PROXY_TOKEN`);
  }
  if (!securityScreen && secretEnv.core?.SECURITY_SCREEN_PROXY_TOKEN !== undefined) {
    throw new CliError(`${path}: secretEnv.core.SECURITY_SCREEN_PROXY_TOKEN requires securityScreen`);
  }
  for (const [service, values] of Object.entries(env)) {
    if (!isServiceName(service)) continue;
    const portEnv = serviceDef(service).docker.portEnv;
    if (values?.[portEnv] !== undefined) {
      throw new CliError(
        `${path}: "env.${service}.${portEnv}" is managed by the deployment target and cannot be overridden`,
      );
    }
  }
  for (const [service, entries] of Object.entries(secretEnv)) {
    if (!isServiceName(service)) continue;
    const portEnv = serviceDef(service).docker.portEnv;
    if (entries?.[portEnv] !== undefined) {
      throw new CliError(
        `${path}: "secretEnv.${service}.${portEnv}" is managed by the deployment target and cannot be overridden`,
      );
    }
  }
  const portalMountsAdmin = services.includes("portal") && services.includes("admin");
  if (portalMountsAdmin && env.admin?.ADMIN_BASE_PATH !== undefined && env.admin.ADMIN_BASE_PATH !== "/admin") {
    throw new CliError(`${path}: env.admin.ADMIN_BASE_PATH must be "/admin" when portal and admin are enabled`);
  }
  if (portalMountsAdmin && secretEnv.admin?.ADMIN_BASE_PATH !== undefined) {
    throw new CliError(
      `${path}: secretEnv.admin.ADMIN_BASE_PATH is managed by the deployment target and cannot be overridden`,
    );
  }
  for (const [i, plugin] of plugins.entries()) {
    if (plugin.env?.PORT !== undefined) {
      throw new CliError(
        `${path}: "plugins[${i}].env.PORT" is managed by the deployment target and cannot be overridden`,
      );
    }
  }
  const imageOverrides = validateServiceMap(o["imageOverrides"], path, "imageOverrides", (v, k) => {
    if (typeof v !== "string") throw new CliError(`${path}: "imageOverrides.${k}" must be a string`);
    return v;
  });
  const sandbox = validateSandbox(o["sandbox"], path, target);

  const out: QmConfig = {
    contract,
    orgId,
    publicUrl: publicUrl.replace(/\/$/, ""),
    target,
    services,
    plugins,
    skills,
    env,
    imageOverrides,
  };
  if (Object.keys(secretEnv).length) out.secretEnv = secretEnv;
  if (securityScreen) out.securityScreen = securityScreen;
  if (typeof apiUrl === "string") out.apiUrl = apiUrl.replace(/\/$/, "");
  if (sandbox) out.sandbox = sandbox;
  if (typeof o["model"] === "string") out.model = o["model"];
  if (o["modelProvider"] !== undefined) {
    if (!isModelProvider(o["modelProvider"])) {
      throw new CliError(
        `${path}: "modelProvider" must be one of ${MODEL_PROVIDERS.join(", ")} — it selects which provider key the deployment requires; omit it to supply the base model key from the Admin page instead`,
      );
    }
    out.modelProvider = o["modelProvider"];
  }
  if (o["basePort"] !== undefined) {
    const bp = o["basePort"];
    if (typeof bp !== "number" || !Number.isInteger(bp) || bp <= 0) {
      throw new CliError(`${path}: "basePort" must be a positive integer (the docker host port base)`);
    }
    out.basePort = bp;
  }
  if (typeof o["appPrefix"] === "string") out.appPrefix = o["appPrefix"];
  if (typeof o["region"] === "string") out.region = o["region"];
  if (typeof o["flyOrg"] === "string") out.flyOrg = o["flyOrg"];
  if (typeof o["imageFrom"] === "string") out.imageFrom = o["imageFrom"];
  if (typeof o["deployAppPrefix"] === "string") out.deployAppPrefix = o["deployAppPrefix"];
  if (o["aws"] !== undefined) {
    const configuredSecretNames = [
      ...plugins.flatMap((plugin) => (plugin.secrets ?? []).map((secret) => secret.name)),
      ...(sandbox?.secretEnv ?? []),
      ...Object.values(secretEnv).flatMap((entries) => Object.values(entries ?? {})),
    ];
    out.aws = validateAws(o["aws"], path, runnableServices(services), configuredSecretNames);
  }
  if (target === "aws" && !out.aws) throw new CliError(`${path}: target "aws" requires an "aws" block`);
  validatePortalTrust(out, path);
  if (target === "aws") {
    validateAwsFrontDoor(out, path);
    const externalImages = [
      ...plugins.filter((plugin) => plugin.image).map((plugin) => plugin.name),
      ...Object.keys(imageOverrides).filter((service) => services.includes(service as DeclaredServiceName)),
    ];
    for (const workload of new Set([...runnableServices(services), ...externalImages])) {
      if (out.aws?.services[workload]) awsWorkloadArchitecture(out, workload);
    }
  }
  if (o["vms"] !== undefined) {
    out.vms = validateServiceMap(o["vms"], path, "vms", (v, k) => {
      if (!isPlainObject(v)) {
        throw new CliError(`${path}: "vms.${k}" must be an object (e.g. { "memory": "4gb" })`);
      }
      const vm = v;
      const vmOut: { size?: string; memory?: string } = {};
      for (const f of ["size", "memory"] as const) {
        const fv = vm[f];
        if (fv === undefined) continue;
        if (typeof fv !== "string") throw new CliError(`${path}: "vms.${k}.${f}" must be a string`);
        vmOut[f] = fv;
      }
      return vmOut;
    });
  }
  return out;
}

const validEmailDomain = (value: string): boolean => {
  if (value.length > 253 || !value.includes(".")) return false;
  return value
    .split(".")
    .every(
      (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
};

const DERIVED_AUTH_ENV_KEYS = ["AUTH_ISSUER", "AUTH_CLIENT_ID", "AUTH_REDIRECT_URI"] as const;

function validateBrokerTrust(config: QmConfig, path: string, secrets?: ReadonlyMap<string, string>): void {
  const portalEnv = config.env.portal ?? {};
  const authEnv = config.env.auth ?? {};
  const overriddenPortal = AUTH_BROKER_ENV_KEYS.find((key) => portalEnv[key] !== undefined);
  if (overriddenPortal) {
    throw new CliError(
      `${path}: env.portal.${overriddenPortal} is derived from the built-in auth broker — remove it, or drop "auth" from "services" to use an external identity provider`,
    );
  }
  const overriddenAuth = DERIVED_AUTH_ENV_KEYS.find((key) => authEnv[key] !== undefined);
  if (overriddenAuth) {
    throw new CliError(`${path}: env.auth.${overriddenAuth} is derived from publicUrl and cannot be set`);
  }
  if (portalEnv.PORTAL_EXPECTED_TEAM_ID !== undefined) {
    throw new CliError(
      `${path}: env.portal.PORTAL_EXPECTED_TEAM_ID belongs to Slack sign-in and has no meaning with the built-in auth broker`,
    );
  }
  const transport = authEnv.AUTH_EMAIL_TRANSPORT?.trim();
  if (transport !== "resend" && transport !== "smtp") {
    throw new CliError(`${path}: env.auth.AUTH_EMAIL_TRANSPORT must be "resend" or "smtp"`);
  }
  const domain = authEnv.AUTH_ALLOWED_EMAIL_DOMAIN?.trim();
  if (
    authEnv.AUTH_ALLOWED_EMAIL_DOMAIN !== undefined &&
    (isMissingOrPlaceholder(domain) || !validEmailDomain(domain!))
  ) {
    throw new CliError(
      `${path}: env.auth.AUTH_ALLOWED_EMAIL_DOMAIN must be a valid, non-placeholder email domain when set`,
    );
  }
  if (!secrets || domain) return;
  const allowed = (secrets.get("AUTH_ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  if (
    !allowed.length ||
    allowed.some((email) => isMissingOrPlaceholder(email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
  ) {
    throw new CliError(
      `${path}: the built-in auth broker requires env.auth.AUTH_ALLOWED_EMAIL_DOMAIN or a valid AUTH_ALLOWED_EMAILS in the target secret store — without one, anybody with an inbox could sign in`,
    );
  }
}

export function validatePortalTrust(config: QmConfig, path = "config", secrets?: ReadonlyMap<string, string>): void {
  if (!config.services.includes("portal")) return;
  if (config.services.includes("auth")) return validateBrokerTrust(config, path, secrets);
  const env = config.env.portal ?? {};
  const issuer = env.OIDC_ISSUER?.trim() || "https://slack.com";
  const jwksUri = env.OIDC_JWKS_URI?.trim();
  if (issuer !== "https://slack.com" && isMissingOrPlaceholder(jwksUri)) {
    throw new CliError(`${path}: portal requires env.portal.OIDC_JWKS_URI when using a non-Slack OIDC issuer`);
  }
  if (jwksUri !== undefined) {
    try {
      if (new URL(jwksUri).protocol !== "https:") throw new Error("protocol");
    } catch {
      throw new CliError(`${path}: env.portal.OIDC_JWKS_URI must be a non-placeholder HTTPS URL`);
    }
  }
  if (env.OIDC_CLIENT_ID !== undefined && isMissingOrPlaceholder(env.OIDC_CLIENT_ID)) {
    throw new CliError(`${path}: env.portal.OIDC_CLIENT_ID may not be a placeholder when configured`);
  }
  if (secrets && isMissingOrPlaceholder(env.OIDC_CLIENT_ID ?? secrets.get("OIDC_CLIENT_ID"))) {
    throw new CliError(
      `${path}: portal requires a non-placeholder OIDC_CLIENT_ID in env.portal or the target secret store`,
    );
  }
  const domain = env.OIDC_ALLOWED_EMAIL_DOMAIN?.trim();
  const allowedEmails =
    env.OIDC_ALLOWED_EMAILS?.split(",")
      .map((email) => email.trim())
      .filter(Boolean) ?? [];
  const configuredTeam = env.PORTAL_EXPECTED_TEAM_ID?.trim();
  if (domain !== undefined && (isMissingOrPlaceholder(domain) || !validEmailDomain(domain))) {
    throw new CliError(
      `${path}: env.portal.OIDC_ALLOWED_EMAIL_DOMAIN must be a valid, non-placeholder email domain when set`,
    );
  }
  if (allowedEmails.some((email) => isMissingOrPlaceholder(email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    throw new CliError(`${path}: env.portal.OIDC_ALLOWED_EMAILS must contain valid, non-placeholder email addresses`);
  }
  if ((domain || allowedEmails.length) && (env.OIDC_PRINCIPAL_CLAIM ?? "email") !== "email") {
    throw new CliError(
      `${path}: portal requires env.portal.OIDC_PRINCIPAL_CLAIM=email when using an email trust boundary`,
    );
  }
  if (env.PORTAL_EXPECTED_TEAM_ID !== undefined && isMissingOrPlaceholder(configuredTeam)) {
    throw new CliError(
      `${path}: env.portal.PORTAL_EXPECTED_TEAM_ID is optional, but may not be a placeholder when configured`,
    );
  }
  if (
    secrets &&
    !domain &&
    !allowedEmails.length &&
    isMissingOrPlaceholder(configuredTeam ?? secrets.get("PORTAL_EXPECTED_TEAM_ID"))
  ) {
    throw new CliError(
      `${path}: portal requires OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_EMAIL_DOMAIN, or a non-placeholder PORTAL_EXPECTED_TEAM_ID in env.portal or the target secret store`,
    );
  }
}

function validateAwsFrontDoor(config: QmConfig, path: string): void {
  const hasPortal = config.services.includes("portal");
  const hasWebUi = config.services.includes("web-ui");
  const publicUrl = new URL(config.publicUrl);
  const protocol = publicUrl.protocol;
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new CliError(`${path}: AWS publicUrl must be an origin URL without credentials, a path, query, or fragment`);
  }
  if (config.apiUrl && new URL(config.apiUrl).protocol !== protocol) {
    throw new CliError(`${path}: AWS apiUrl must use the same protocol as publicUrl`);
  }
  const deployImage = config.env.core?.AWS_DEPLOY_IMAGE?.trim();
  if (isMissingOrPlaceholder(deployImage) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(deployImage!)) {
    throw new CliError(
      `${path}: AWS requires env.core.AWS_DEPLOY_IMAGE to name a non-placeholder, stack-owned Lambda MicroVM image`,
    );
  }
  if (hasWebUi && !hasPortal) {
    throw new CliError(
      `${path}: AWS web-ui requires the authenticated portal; a portal-free ALB must never expose the Web UI`,
    );
  }
  if (config.services.includes("admin") && !hasPortal) {
    throw new CliError(`${path}: AWS admin requires the authenticated portal`);
  }
  if (hasPortal && !hasWebUi) {
    throw new CliError(`${path}: AWS portal requires web-ui`);
  }
  if (hasPortal && protocol !== "https:") {
    throw new CliError(`${path}: AWS portal requires an HTTPS publicUrl and ACM certificate`);
  }
  const harness = config.env.core?.HARNESS?.trim() || "mock";
  if (protocol !== "https:" && harness !== "mock") {
    throw new CliError(
      `${path}: AWS HARNESS=${harness} requires an HTTPS publicUrl so sandbox capabilities never cross the Internet in cleartext`,
    );
  }
}

function validatePlugins(raw: unknown, path: string): PluginEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new CliError(`${path}: "plugins" must be an array`);
  const seen = new Set<string>();
  return raw.map((p, i) => {
    if (typeof p !== "object" || p === null) throw new CliError(`${path}: plugins[${i}] must be an object`);
    const e = p as Record<string, unknown>;
    if (typeof e["name"] !== "string" || !e["name"].trim()) throw new CliError(`${path}: plugins[${i}].name required`);
    const name = e["name"];
    const nameError = pluginNameError(name);
    if (nameError) throw new CliError(`${path}: plugins[${i}].name ${JSON.stringify(name)} ${nameError}`);
    if (seen.has(name)) throw new CliError(`${path}: duplicate plugin name ${JSON.stringify(name)}`);
    seen.add(name);
    const entry: PluginEntry = { name };
    if (e["image"] !== undefined) {
      if (typeof e["image"] !== "string" || !e["image"].trim()) {
        throw new CliError(`${path}: plugins[${i}].image must be a non-empty string (a pullable image ref) when set`);
      }
      entry.image = e["image"];
    }
    if (e["env"] !== undefined) entry.env = validateStringMap(e["env"], path, `plugins[${i}].env`);
    if (e["secrets"] !== undefined) entry.secrets = validatePluginSecrets(e["secrets"], path, i);
    return entry;
  });
}

function validatePluginSecrets(raw: unknown, path: string, pluginIndex: number): PluginSecret[] {
  if (!Array.isArray(raw)) throw new CliError(`${path}: plugins[${pluginIndex}].secrets must be an array`);
  const seen = new Set<string>();
  return raw.map((value, i) => {
    const field = `plugins[${pluginIndex}].secrets[${i}]`;
    if (!isPlainObject(value)) throw new CliError(`${path}: ${field} must be an object`);
    const name = value["name"];
    if (typeof name !== "string" || !isEnvVarName(name))
      throw new CliError(`${path}: ${field}.name must be a valid env var name`);
    if (seen.has(name)) throw new CliError(`${path}: duplicate plugin secret ${JSON.stringify(name)}`);
    seen.add(name);
    const out: PluginSecret = { name };
    if (value["description"] !== undefined) {
      if (typeof value["description"] !== "string")
        throw new CliError(`${path}: ${field}.description must be a string`);
      out.description = value["description"];
    }
    if (value["required"] !== undefined) {
      if (typeof value["required"] !== "boolean") throw new CliError(`${path}: ${field}.required must be a boolean`);
      out.required = value["required"];
    }
    return out;
  });
}

function validateAws(
  raw: unknown,
  path: string,
  enabledServices: ServiceName[],
  configuredSecretNames: string[],
): AwsConfig {
  if (!isPlainObject(raw)) throw new CliError(`${path}: "aws" must be an object`);
  const requiredString = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim())
      throw new CliError(`${path}: "aws.${field}" must be a non-empty string`);
    return value;
  };
  const networking = raw["networking"];
  if (!isPlainObject(networking)) throw new CliError(`${path}: "aws.networking" must be an object`);
  const accountId = requiredString(raw["accountId"], "accountId");
  if (!/^\d{12}$/.test(accountId)) throw new CliError(`${path}: "aws.accountId" must be exactly 12 digits`);
  const cluster = requiredString(raw["cluster"], "cluster");
  if (cluster.length > 49 || !/^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/.test(cluster)) {
    throw new CliError(
      `${path}: "aws.cluster" must be at most 49 lowercase letters, digits, and single hyphens, start with a letter, and end with a letter or digit so its derived IAM and RDS names are valid`,
    );
  }
  const region = requiredString(raw["region"], "region");
  if (/^(?:cn-|us-gov-|us-iso|eu-isoe-)/.test(region)) {
    throw new CliError(
      `${path}: "aws.region" must be in the commercial AWS partition; GovCloud, China, and isolated partitions are not supported`,
    );
  }
  const secretsPrefix = requiredString(raw["secretsPrefix"], "secretsPrefix");
  if (secretsPrefix.length > 256 || !/^[A-Za-z0-9/_+=.@-]+$/.test(secretsPrefix)) {
    throw new CliError(
      `${path}: "aws.secretsPrefix" must be at most 256 AWS secret-name characters (letters, digits, /_+=.@-) so computed secret names fit`,
    );
  }
  const oversizedSecret = configuredSecretNames.find((name) => `${secretsPrefix}${name}`.length > 512);
  if (oversizedSecret) {
    throw new CliError(
      `${path}: "aws.secretsPrefix" plus computed secret ${JSON.stringify(oversizedSecret)} exceeds the 512-character AWS secret-name limit`,
    );
  }
  const imageLabel = requiredString(raw["imageLabel"], "imageLabel");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(imageLabel)) {
    throw new CliError(
      `${path}: "aws.imageLabel" must be a valid OCI/ECR tag (1-128 letters, digits, underscores, periods, or hyphens; the first character cannot be a period or hyphen)`,
    );
  }
  let alb: string | undefined;
  if (raw["alb"] !== undefined) {
    alb = requiredString(raw["alb"], "alb");
    if (alb.length > 32 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(alb) || alb.startsWith("internal-")) {
      throw new CliError(
        `${path}: "aws.alb" must be a valid load balancer name (at most 32 letters, digits, and interior hyphens, not starting with "internal-")`,
      );
    }
  }
  let rdsInstance: string | undefined;
  if (raw["rdsInstance"] !== undefined) {
    rdsInstance = requiredString(raw["rdsInstance"], "rdsInstance");
    if (rdsInstance.length > 63 || !/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(rdsInstance) || rdsInstance.includes("--")) {
      throw new CliError(
        `${path}: "aws.rdsInstance" must be a valid DB instance identifier (at most 63 lowercase characters, starting with a letter, no double or trailing hyphens)`,
      );
    }
  }
  let predeployDbSnapshot: boolean | undefined;
  if (raw["predeployDbSnapshot"] !== undefined) {
    if (typeof raw["predeployDbSnapshot"] !== "boolean") {
      throw new CliError(
        `${path}: "aws.predeployDbSnapshot" must be a boolean (false skips the pre-deploy RDS snapshot)`,
      );
    }
    predeployDbSnapshot = raw["predeployDbSnapshot"];
  }
  let dbRetentionMinDays: number | undefined;
  if (raw["dbRetentionMinDays"] !== undefined) {
    const days = raw["dbRetentionMinDays"];
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 35) {
      throw new CliError(
        `${path}: "aws.dbRetentionMinDays" must be an integer between 0 and 35 (the RDS automated-backup retention range)`,
      );
    }
    dbRetentionMinDays = days;
  }
  let objectStoreBucket: string | undefined;
  if (raw["objectStoreBucket"] !== undefined) {
    objectStoreBucket = requiredString(raw["objectStoreBucket"], "objectStoreBucket");
    if (
      objectStoreBucket.length < 3 ||
      objectStoreBucket.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(objectStoreBucket) ||
      objectStoreBucket.includes("..") ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(objectStoreBucket)
    ) {
      throw new CliError(
        `${path}: "aws.objectStoreBucket" must be a valid S3 bucket name (3-63 lowercase letters, digits, and interior hyphens or dots; not IP-address-formatted)`,
      );
    }
  }
  let deployBranch: string | undefined;
  if (raw["deployBranch"] !== undefined) {
    deployBranch = requiredString(raw["deployBranch"], "deployBranch");
    const segments = deployBranch.split("/");
    if (
      deployBranch.length > 255 ||
      deployBranch.startsWith("refs/") ||
      deployBranch.includes("..") ||
      !/^[A-Za-z0-9._/-]+$/.test(deployBranch) ||
      segments.some(
        (segment) => !segment || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock"),
      )
    ) {
      throw new CliError(`${path}: "aws.deployBranch" must be a valid git branch name (not a refs/* path)`);
    }
  }
  let deployEnvironment: string | undefined;
  if (raw["deployEnvironment"] !== undefined) {
    deployEnvironment = requiredString(raw["deployEnvironment"], "deployEnvironment");
    if (deployEnvironment.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deployEnvironment)) {
      throw new CliError(`${path}: "aws.deployEnvironment" must be a valid GitHub environment name`);
    }
  }
  const cloudMapNamespace = requiredString(networking["cloudMapNamespace"], "networking.cloudMapNamespace");
  const namespaceLabels = cloudMapNamespace.split(".");
  if (
    cloudMapNamespace.length > 253 ||
    namespaceLabels.some(
      (label) => label.length === 0 || label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  ) {
    throw new CliError(
      `${path}: "aws.networking.cloudMapNamespace" must be a valid DNS namespace of at most 253 characters with labels of at most 63 characters`,
    );
  }
  const roleArn = (value: unknown, field: string): string => {
    const arn = requiredString(value, field);
    const match = arn.match(/^arn:aws:iam::([0-9]{12}):role\/[A-Za-z0-9_+=,.@/-]{1,512}$/);
    if (!match || match[1] !== accountId) {
      throw new CliError(
        `${path}: "aws.${field}" must be an IAM role ARN in account ${accountId} and the commercial AWS partition`,
      );
    }
    return arn;
  };
  const deployRoleArn = roleArn(raw["deployRoleArn"], "deployRoleArn");
  const servicesRaw = raw["services"];
  if (!isPlainObject(servicesRaw))
    throw new CliError(`${path}: "aws.services" must be an object keyed by service name`);
  const services: Record<string, AwsServiceConfig> = {};
  const coordinates = {
    ecrRepository: new Map<string, string>(),
    ecsService: new Map<string, string>(),
    targetGroup: new Map<string, string>(),
  };
  const validFargateSize = (cpu: number, memory: number): boolean => {
    const range = (min: number, max: number, step: number): boolean =>
      memory >= min && memory <= max && (memory - min) % step === 0;
    if (cpu === 256) return [512, 1024, 2048].includes(memory);
    if (cpu === 512) return range(1024, 4096, 1024);
    if (cpu === 1024) return range(2048, 8192, 1024);
    if (cpu === 2048) return range(4096, 16384, 1024);
    if (cpu === 4096) return range(8192, 30720, 1024);
    if (cpu === 8192) return range(16384, 61440, 4096);
    if (cpu === 16384) return range(32768, 122880, 8192);
    return false;
  };
  for (const [name, value] of Object.entries(servicesRaw)) {
    if (!isServiceName(name) && pluginNameError(name)) {
      throw new CliError(`${path}: "aws.services" has invalid workload name "${name}"`);
    }
    if (!isPlainObject(value)) throw new CliError(`${path}: "aws.services.${name}" must be an object`);
    const positiveInt = (field: "cpu" | "memory"): number => {
      const n = value[field];
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        throw new CliError(`${path}: "aws.services.${name}.${field}" must be a positive integer`);
      }
      return n;
    };
    const service: AwsServiceConfig = {
      ecrRepository: requiredString(value["ecrRepository"], `services.${name}.ecrRepository`),
      ecsService: requiredString(value["ecsService"], `services.${name}.ecsService`),
      cpu: positiveInt("cpu"),
      memory: positiveInt("memory"),
    };
    if (!validFargateSize(service.cpu, service.memory)) {
      throw new CliError(
        `${path}: "aws.services.${name}" cpu ${service.cpu} and memory ${service.memory} are not a supported Fargate task size`,
      );
    }
    for (const field of ["ecrRepository", "ecsService"] as const) {
      const previous = coordinates[field].get(service[field]);
      if (previous) {
        throw new CliError(
          `${path}: "aws.services.${name}.${field}" duplicates aws.services.${previous}.${field} (${JSON.stringify(service[field])})`,
        );
      }
      coordinates[field].set(service[field], name);
    }
    for (const role of ["taskRoleArn", "executionRoleArn"] as const) {
      if (value[role] !== undefined) service[role] = roleArn(value[role], `services.${name}.${role}`);
    }
    if (value["architecture"] !== undefined) {
      if (value["architecture"] !== "arm64" && value["architecture"] !== "amd64") {
        throw new CliError(`${path}: "aws.services.${name}.architecture" must be "arm64" or "amd64"`);
      }
      service.architecture = value["architecture"];
    }
    if (value["desiredCount"] !== undefined) {
      const desiredCount = value["desiredCount"];
      if (typeof desiredCount !== "number" || !Number.isInteger(desiredCount) || desiredCount <= 0) {
        throw new CliError(`${path}: "aws.services.${name}.desiredCount" must be a positive integer`);
      }
      service.desiredCount = desiredCount;
    }
    if (value["targetGroup"] !== undefined) {
      const targetGroup = requiredString(value["targetGroup"], `services.${name}.targetGroup`);
      if (targetGroup.length > 32 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(targetGroup)) {
        throw new CliError(
          `${path}: "aws.services.${name}.targetGroup" must be a valid target group name (at most 32 letters, digits, and interior hyphens)`,
        );
      }
      const previous = coordinates.targetGroup.get(targetGroup);
      if (previous) {
        throw new CliError(
          `${path}: "aws.services.${name}.targetGroup" duplicates aws.services.${previous}.targetGroup (${JSON.stringify(targetGroup)})`,
        );
      }
      coordinates.targetGroup.set(targetGroup, name);
      service.targetGroup = targetGroup;
    }
    if (value["logGroup"] !== undefined) {
      const logGroup = requiredString(value["logGroup"], `services.${name}.logGroup`);
      if (logGroup.length > 512 || !/^[A-Za-z0-9_/.#-]+$/.test(logGroup)) {
        throw new CliError(
          `${path}: "aws.services.${name}.logGroup" must be a valid CloudWatch log group name (at most 512 characters: letters, digits, _ / . # -)`,
        );
      }
      service.logGroup = logGroup;
    }
    if (value["stopTimeout"] !== undefined) {
      const stopTimeout = value["stopTimeout"];
      if (typeof stopTimeout !== "number" || !Number.isInteger(stopTimeout) || stopTimeout < 2 || stopTimeout > 120) {
        throw new CliError(
          `${path}: "aws.services.${name}.stopTimeout" must be an integer between 2 and 120 seconds (the Fargate limit)`,
        );
      }
      service.stopTimeout = stopTimeout;
    }
    if (value["buildArgs"] !== undefined)
      service.buildArgs = validateStringMap(value["buildArgs"], path, `aws.services.${name}.buildArgs`);
    if (value["dockerfile"] !== undefined) {
      const dockerfile = requiredString(value["dockerfile"], `services.${name}.dockerfile`);
      if (isAbsolute(dockerfile) || dockerfile.includes("\\") || dockerfile.split("/").includes("..")) {
        throw new CliError(
          `${path}: "aws.services.${name}.dockerfile" must be a forward-slash relative path inside the build checkout`,
        );
      }
      service.dockerfile = dockerfile;
    }
    services[name] = service;
  }
  for (const name of enabledServices) {
    if (!services[name]) throw new CliError(`${path}: "aws.services.${name}" is required because ${name} is enabled`);
  }
  const netOut: AwsConfig["networking"] = {
    cloudMapNamespace,
  };
  for (const key of ["subnets", "securityGroups"] as const) {
    if (networking[key] !== undefined) {
      throw new CliError(
        `${path}: "aws.networking.${key}" is not supported; network placement belongs to the provisioned ECS services`,
      );
    }
  }
  const out: AwsConfig = {
    accountId,
    region,
    cluster,
    deployRoleArn,
    secretsPrefix,
    imageLabel,
    networking: netOut,
    services,
  };
  if (alb) out.alb = alb;
  if (rdsInstance) out.rdsInstance = rdsInstance;
  if (predeployDbSnapshot !== undefined) out.predeployDbSnapshot = predeployDbSnapshot;
  if (dbRetentionMinDays !== undefined) out.dbRetentionMinDays = dbRetentionMinDays;
  if (deployBranch) out.deployBranch = deployBranch;
  if (deployEnvironment) out.deployEnvironment = deployEnvironment;
  if (objectStoreBucket) out.objectStoreBucket = objectStoreBucket;
  return out;
}

function validateSandbox(raw: unknown, path: string, target: Target): SandboxConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new CliError(`${path}: "sandbox" must be an object (e.g. { "app": "acme-sandboxes" })`);
  }
  const o = raw;
  const assertEnvName = (name: string, field: string): void => {
    if (!isEnvVarName(name)) {
      throw new CliError(`${path}: ${field} ${JSON.stringify(name)} is not a valid env var name`);
    }
  };
  const out: SandboxConfig = {};
  if (o["backend"] !== undefined) {
    if (o["backend"] !== "sprites" && o["backend"] !== "aws") {
      throw new CliError(
        `${path}: "sandbox.backend" must be "sprites" (Fly Sprites, booting the operator-published layer image from the Fly app in "sandbox.app") or "aws" (Lambda MicroVM sandboxes)`,
      );
    }
    out.backend = o["backend"];
  }
  if (o["app"] !== undefined) {
    if (typeof o["app"] !== "string" || !o["app"].trim()) {
      throw new CliError(`${path}: "sandbox.app" must be a non-empty string (the Fly sandbox app name)`);
    }
    out.app = o["app"];
  }
  if (o["image"] !== undefined) {
    if (typeof o["image"] !== "string" || !o["image"].trim()) {
      throw new CliError(`${path}: "sandbox.image" must be a non-empty string (a pullable rootfs image ref)`);
    }
    out.image = o["image"];
  }
  if (o["baseImage"] !== undefined) {
    if (typeof o["baseImage"] !== "string" || !o["baseImage"].trim()) {
      throw new CliError(`${path}: "sandbox.baseImage" must be a non-empty digest-pinned image ref`);
    }
    if (!o["baseImage"].includes("@sha256:")) {
      throw new CliError(`${path}: "sandbox.baseImage" must be pinned by digest (@sha256:...)`);
    }
    out.baseImage = o["baseImage"];
  }
  if (o["env"] !== undefined) {
    out.env = validateStringMap(o["env"], path, "sandbox.env");
    for (const k of Object.keys(out.env)) assertEnvName(k, `"sandbox.env" key`);
  }
  if (o["secretEnv"] !== undefined) {
    const se = validateStringArray(o["secretEnv"], path, "sandbox.secretEnv");
    for (const name of se) assertEnvName(name, `"sandbox.secretEnv" entry`);
    out.secretEnv = se;
  }
  if (out.backend === "aws") {
    if (target !== "aws") {
      throw new CliError(`${path}: "sandbox.backend": "aws" (Lambda MicroVM sandboxes) requires target "aws"`);
    }
    const stray = (["app", "image", "baseImage", "env", "secretEnv"] as const).filter((key) => out[key] !== undefined);
    if (stray.length) {
      throw new CliError(
        `${path}: "sandbox.backend": "aws" runs Lambda MicroVM sandboxes, which ignore ${stray.map((key) => `"sandbox.${key}"`).join(", ")} (Fly layer-image settings) — remove them or set "sandbox.backend": "sprites"`,
      );
    }
  }
  if (out.image && !out.app) {
    throw new CliError(`${path}: "sandbox.image" requires "sandbox.app" (the app the microVMs run in)`);
  }
  if (out.backend === "sprites" && !out.app) {
    throw new CliError(
      `${path}: "sandbox.backend": ${JSON.stringify(out.backend)} requires "sandbox.app" (the Fly app agents execute in)`,
    );
  }
  if (target === "aws" && out.backend === undefined) {
    throw new CliError(
      `${path}: target "aws" requires an explicit "sandbox.backend" — "sprites" boots the operator-published layer image in "sandbox.app"; "aws" runs Lambda MicroVM sandboxes (or omit the whole "sandbox" block for the MicroVM default)`,
    );
  }
  return out;
}

function validateStringArray(raw: unknown, path: string, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    throw new CliError(`${path}: "${field}" must be an array of strings`);
  }
  return raw as string[];
}

function validateStringMap(raw: unknown, path: string, field: string): Record<string, string> {
  if (!isPlainObject(raw)) {
    throw new CliError(`${path}: "${field}" must be an object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new CliError(`${path}: "${field}.${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

function validateServiceMap<T>(
  raw: unknown,
  path: string,
  field: string,
  value: (v: unknown, key: string) => T,
): Partial<Record<DeclaredServiceName, T>> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new CliError(`${path}: "${field}" must be an object keyed by service name`);
  }
  const out: Partial<Record<DeclaredServiceName, T>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(field === "env" || field === "secretEnv" ? isDeclaredService(k) : isServiceName(k)))
      throw new CliError(`${path}: "${field}" has unknown service "${k}"`);
    out[k as DeclaredServiceName] = value(v, k);
  }
  return out;
}
