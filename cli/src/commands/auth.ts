import { join, resolve } from "node:path";
import { coreRequest, type DeploymentLayerTransport } from "../deployment-layer.ts";
import type { QmConfig } from "../config.ts";
import { CliError, note, ok } from "../log.ts";
import { deploymentSecretValue, readEnvFile } from "../util.ts";

interface AuthCommandContext {
  config: QmConfig;
  configDir: string;
  envFile?: string;
  transport: DeploymentLayerTransport;
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}

function envOf(ctx: AuthCommandContext): Map<string, string> {
  return readEnvFile(resolve(ctx.envFile ?? join(ctx.configDir, ".env")));
}

function principalOf(ctx: AuthCommandContext, explicit: string | undefined): string {
  const candidate = explicit?.trim().toLowerCase();
  if (candidate) {
    if (!validEmail(candidate)) throw new CliError("--principal must be a valid email address");
    return candidate;
  }
  const env = envOf(ctx);
  const secretName = ctx.config.secretEnv?.core?.ADMIN_GRANTS ?? "ADMIN_GRANTS";
  const grants =
    deploymentSecretValue(secretName, env.get(secretName)) ??
    (secretName === "ADMIN_GRANTS" ? undefined : deploymentSecretValue("ADMIN_GRANTS", env.get("ADMIN_GRANTS"))) ??
    "";
  const principals = grants
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.endsWith(":org_admin"))
    .map((entry) => entry.slice(0, -":org_admin".length).trim().toLowerCase())
    .filter(validEmail);
  const unique = [...new Set(principals)];
  if (unique.length !== 1) {
    throw new CliError("pass --principal <email> when ADMIN_GRANTS does not contain exactly one email administrator");
  }
  return unique[0]!;
}

async function request(ctx: AuthCommandContext, method: "GET" | "POST", path: string, body?: unknown) {
  const response = await coreRequest({
    config: ctx.config,
    configDir: ctx.configDir,
    method,
    path,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
    transport: ctx.transport,
  });
  const payload = JSON.parse(response.body || "{}") as Record<string, unknown>;
  if (response.status < 200 || response.status >= 300) {
    throw new CliError(typeof payload.message === "string" ? payload.message : `core returned HTTP ${response.status}`);
  }
  return payload;
}

function assertServices(config: QmConfig): void {
  for (const service of ["core", "portal", "admin", "auth"] as const) {
    if (!config.services.includes(service)) throw new CliError(`qm auth requires the ${service} service`);
  }
}

export async function runAuthBootstrap(ctx: AuthCommandContext, explicitPrincipal?: string): Promise<void> {
  assertServices(ctx.config);
  const principal = principalOf(ctx, explicitPrincipal);
  const result = await request(ctx, "POST", "/v1/operator/auth-email-settings/bootstrap", { principal });
  if (typeof result.token !== "string" || !result.token) throw new CliError("core returned no bootstrap token");
  const url = new URL(ctx.config.publicUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/auth/bootstrap`;
  url.search = "";
  url.hash = `token=${encodeURIComponent(result.token)}`;
  note(`One-time Admin link for ${principal} (expires in 10 minutes):\n${url.toString()}`);
}

export async function runAuthFallback(ctx: AuthCommandContext, explicitPrincipal?: string): Promise<void> {
  assertServices(ctx.config);
  const principal = principalOf(ctx, explicitPrincipal);
  await request(ctx, "POST", "/v1/operator/auth-email-settings/fallback", { principal });
  ok(`deployment email settings validated and activated for ${principal}`);
}
