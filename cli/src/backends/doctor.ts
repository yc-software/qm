import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MODEL_PROVIDER_KEYS,
  localSandboxActive,
  mockHarnessWarning,
  validatePortalTrust,
  type ModelProvider,
  type QmConfig,
} from "../config.ts";
import { CliError, errMessage, step, warn } from "../log.ts";
import { capture, deploymentSecretValue, flyBin, isInvalidSecret, readEnvFile, which } from "../util.ts";
import { computedSecrets, serviceSecretValue } from "../secrets.ts";
import { emailTransportConfigured } from "../preflight.ts";

export function slackManifestBotScopes(manifest: string): string[] {
  try {
    const parsed = JSON.parse(manifest) as { oauth_config?: { scopes?: { bot?: string[] } } };
    return parsed.oauth_config?.scopes?.bot ?? [];
  } catch {
    const clean = (item: string): string =>
      item
        .split(/\s+#/)[0]!
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();
    const lines = manifest.split("\n");
    const inline = lines.map((line) => line.match(/^\s*bot:\s*\[(.*)\]\s*(?:#.*)?$/)).find(Boolean);
    if (inline) return inline[1]!.split(",").map(clean).filter(Boolean);
    const start = lines.findIndex((line) => /^\s*bot:\s*(?:#.*)?$/.test(line));
    if (start === -1) return [];
    const indent = lines[start]!.match(/^\s*/)![0].length;
    const scopes: string[] = [];
    for (const line of lines.slice(start + 1)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (line.match(/^\s*/)![0].length <= indent) break;
      const item = trimmed.match(/^-\s*(.+)$/);
      if (!item) break;
      const scope = clean(item[1]!);
      if (scope) scopes.push(scope);
    }
    return scopes;
  }
}

export function requiredSlackScopes(configDir?: string): string[] {
  const local = configDir ? join(configDir, "slack-app-manifest.yml") : undefined;
  const sourceTemplate = new URL("../../templates/slack-manifest.json", import.meta.url);
  const packagedTemplate = new URL("../../../templates/slack-manifest.json", import.meta.url);
  const templatePath = existsSync(sourceTemplate) ? sourceTemplate : packagedTemplate;
  const path = local && existsSync(local) ? local : templatePath;
  const scopes = slackManifestBotScopes(readFileSync(path, "utf8"));
  if (scopes.length === 0) {
    throw new CliError(
      `no bot scopes parse from ${path} — fix oauth_config.scopes.bot in the manifest (doctor cannot verify Slack scopes against an empty list)`,
    );
  }
  if (path === local) {
    const behind = slackManifestBotScopes(readFileSync(templatePath, "utf8")).filter(
      (scope) => !scopes.includes(scope),
    );
    if (behind.length)
      warn(
        `slack-app-manifest.yml lacks bot scopes the current slack plugin uses (${behind.join(", ")}) — merge them from the CLI's template and reinstall the app`,
      );
  }
  return scopes;
}

async function slackApi(
  url: string,
  init: { method?: string; headers: Record<string, string> },
): Promise<{ res: Response; body: { ok?: boolean; error?: string } }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new CliError(`could not reach ${url}: ${errMessage(e)} — check network access (and any proxy) and retry`);
  }
  try {
    return { res, body: (await res.json()) as { ok?: boolean; error?: string } };
  } catch {
    throw new CliError(`${url} returned a non-JSON response (status ${res.status}) — Slack may be degraded; retry`);
  }
}

async function slackCheck(botToken: string, appToken: string, configDir?: string): Promise<void> {
  const auth = await slackApi("https://slack.com/api/auth.test", { headers: { authorization: `Bearer ${botToken}` } });
  if (!auth.res.ok || !auth.body.ok)
    throw new CliError(`Slack bot token rejected (${auth.body.error ?? auth.res.status})`);
  const granted = new Set(
    (auth.res.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  const missing = requiredSlackScopes(configDir).filter((scope) => !granted.has(scope));
  if (missing.length)
    throw new CliError(
      `Slack app is missing scopes: ${missing.join(", ")}; update from slack-app-manifest.yml and reinstall`,
    );
  const socket = await slackApi("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}`, "content-type": "application/x-www-form-urlencoded" },
  });
  if (!socket.res.ok || !socket.body.ok)
    throw new CliError(`Slack app token rejected (${socket.body.error ?? socket.res.status})`);
}

export function localDoctorSecrets(configDir: string, envFile?: string): Map<string, string> {
  const path = resolve(envFile ?? join(configDir, ".env"));
  if (envFile && !existsSync(path)) throw new CliError(`--env-file not found: ${envFile}`);
  return existsSync(path) ? readEnvFile(path) : new Map();
}

export function requireFlyAuth(): void {
  if (!which(flyBin())) {
    throw new CliError(
      `flyctl not found on PATH — install it (https://fly.io/docs/flyctl/install/) and run \`fly auth login\``,
    );
  }
  try {
    capture(flyBin(), ["auth", "whoami"]);
  } catch (e) {
    throw new CliError(`fly auth whoami failed: ${errMessage(e)} — run \`fly auth login\``);
  }
}

export async function doctorCommon(
  config: QmConfig,
  secrets: Map<string, string>,
  opts: { requiredSecretValues?: boolean; configDir?: string } = {},
): Promise<void> {
  if (opts.requiredSecretValues) {
    const missing = computedSecrets(config)
      .filter((secret) => secret.required)
      .filter((secret) => {
        const value = deploymentSecretValue(secret.name, secrets.get(secret.name));
        return isInvalidSecret(secret.name, value);
      });
    if (missing.length)
      throw new CliError(
        `required secrets are missing or placeholders: ${missing.map((secret) => secret.name).join(", ")}`,
      );
    step("required local secret values: ok");
  }
  if (localSandboxActive(config)) {
    step("local Docker sandbox: configured");
  } else if (config.target === "aws") {
    step("AWS Lambda MicroVM sandbox: configured");
  } else if (config.sandbox?.app) {
    requireFlyAuth();
    try {
      capture(flyBin(), ["status", "-a", config.sandbox.app]);
    } catch (e) {
      throw new CliError(
        `fly status -a ${config.sandbox.app} failed: ${errMessage(e)} — does the sandbox app exist and can this account see it?`,
      );
    }
    step(`Fly sandbox ${config.sandbox.app}: ok`);
  } else {
    step("sandbox: not configured — agents cannot execute commands (HARNESS=mock turns only)");
  }

  if (config.services.includes("slack")) {
    const bot = deploymentSecretValue("SLACK_BOT_TOKEN", secrets.get("SLACK_BOT_TOKEN"));
    const app = deploymentSecretValue("SLACK_APP_TOKEN", secrets.get("SLACK_APP_TOKEN"));
    if (Boolean(bot) !== Boolean(app)) {
      throw new CliError(
        "Slack setup needs both SLACK_BOT_TOKEN and SLACK_APP_TOKEN, or neither when setup is deferred",
      );
    }
    if (bot && app) {
      await slackCheck(bot, app, opts.configDir);
      if (opts.requiredSecretValues) {
        step("Slack tokens and manifest scopes: ok");
      } else if (config.target === "aws") {
        step("Slack tokens and manifest scopes: ok (verified the stored AWS secret values)");
      } else {
        step(
          "Slack tokens and manifest scopes: ok (verified the local .env values — Fly's staged secrets are write-only and may differ)",
        );
      }
    } else if (opts.requiredSecretValues) {
      step("Slack setup: deferred to the admin connector page");
    } else {
      warn(
        config.target === "aws"
          ? "SLACK_BOT_TOKEN/SLACK_APP_TOKEN are not in the AWS secret store yet — skipping the live Slack check"
          : "SLACK_BOT_TOKEN/SLACK_APP_TOKEN values are not available locally — skipping the live Slack check (secret names were verified on the Fly apps)",
      );
    }
  }
  if (config.services.includes("portal")) {
    validatePortalTrust(config, "config", opts.requiredSecretValues ? secrets : undefined);
    step(
      config.services.includes("auth")
        ? "built-in sign-in broker and email trust boundary: ok"
        : "portal OIDC client and tenant trust boundary: ok",
    );
  }
  if (config.services.includes("auth")) await authBrokerCheck(config, secrets, opts.requiredSecretValues === true);
  await baseModelCheck(config, secrets);
}

async function baseModelCheck(config: QmConfig, secrets: Map<string, string>): Promise<void> {
  const mockHarness = mockHarnessWarning(config);
  if (mockHarness) warn(mockHarness);
  const provider = config.modelProvider;
  if (!provider) {
    step("base model: no modelProvider set — an administrator supplies the key from the Admin page");
    return;
  }
  const name = MODEL_PROVIDER_KEYS[provider];
  const key = deploymentSecretValue(name, secrets.get(name));
  if (!key) {
    warn(`${name} is not available locally — skipping the live ${provider} check`);
    return;
  }
  await modelProviderCheck(provider, key);
  step(`base model provider ${provider}: ${name} accepted`);
}

const MODEL_PROVIDER_PROBES: Readonly<
  Record<ModelProvider, { url: string; headers: (key: string) => Record<string, string> }>
> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
  openai: { url: "https://api.openai.com/v1/models", headers: (key) => ({ authorization: `Bearer ${key}` }) },
  openrouter: { url: "https://openrouter.ai/api/v1/key", headers: (key) => ({ authorization: `Bearer ${key}` }) },
};

async function modelProviderCheck(provider: ModelProvider, apiKey: string): Promise<void> {
  const probe = MODEL_PROVIDER_PROBES[provider];
  let res: Response;
  try {
    res = await fetch(probe.url, { headers: probe.headers(apiKey), signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new CliError(
      `could not reach the ${provider} API: ${errMessage(e)} — check network access (and any proxy) and retry`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new CliError(
      `${provider} rejected ${MODEL_PROVIDER_KEYS[provider]} — the deployment would start but could not serve a single agent turn`,
    );
  }
  if (!res.ok) throw new CliError(`the ${provider} API returned HTTP ${res.status}; retry when it recovers`);
}

async function resendCheck(apiKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/domains", {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new CliError(
      `could not reach the Resend API: ${errMessage(e)} — check network access (and any proxy) and retry`,
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new CliError("Resend rejected RESEND_API_KEY — mint a key with send access at https://resend.com/api-keys");
  if (!res.ok) throw new CliError(`the Resend API returned HTTP ${res.status}; retry when it recovers`);
}

async function smtpReachable(host: string, port: number): Promise<string> {
  const { connect } = await import("node:net");
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port });
    const done = (error?: Error, greeting?: string): void => {
      socket.destroy();
      if (error) reject(error);
      else resolve(greeting ?? "");
    };
    socket.setTimeout(10_000, () => done(new Error("connection timed out")));
    socket.once("error", (e: Error) => done(e));
    socket.once("data", (chunk: Buffer) => done(undefined, chunk.toString("utf8").split("\r\n")[0] ?? ""));
  });
}

async function authBrokerCheck(config: QmConfig, secrets: Map<string, string>, haveValues: boolean): Promise<void> {
  if (haveValues && !emailTransportConfigured(config, secrets)) {
    step("sign-in email: disabled; use qm admin-login for administrator access");
    return;
  }
  const transport = config.env.auth?.AUTH_EMAIL_TRANSPORT?.trim() === "smtp" ? "smtp" : "resend";
  const value = (name: string): string | undefined => serviceSecretValue(config, "auth", name, secrets);
  const sender = value("AUTH_EMAIL_FROM");
  if (haveValues) {
    const address = (/<([^>]+)>\s*$/.exec((sender ?? "").trim())?.[1] ?? sender ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      throw new CliError(
        `AUTH_EMAIL_FROM must be a verified sender address, optionally as "Name <sender@example.com>" (got ${JSON.stringify(sender ?? "")})`,
      );
    }
    step(`sign-in links send from ${address}`);
  }
  if (transport === "resend") {
    const key = value("RESEND_API_KEY");
    if (!key) {
      warn("RESEND_API_KEY is not available locally — skipping the live Resend check");
      return;
    }
    await resendCheck(key);
    step("Resend API key: ok (verify the sending domain under https://resend.com/domains)");
    return;
  }
  const host = value("SMTP_HOST");
  if (!host) {
    warn("SMTP_HOST is not available locally — skipping the live SMTP reachability check");
    return;
  }
  const port = Number(config.env.auth?.SMTP_PORT ?? 587);
  let greeting: string;
  try {
    greeting = await smtpReachable(host, port);
  } catch (e) {
    throw new CliError(
      `SMTP relay ${host}:${port} is unreachable: ${errMessage(e)} — the broker cannot send sign-in links`,
    );
  }
  step(`SMTP relay ${host}:${port}: reachable (${greeting || "no greeting"})`);
}
