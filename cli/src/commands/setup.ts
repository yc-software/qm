import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CONFIG_FILENAME, configPathInDir, loadConfigAt, validOrgId, type Target, type QmConfig } from "../config.ts";
import { bold, die, dim, header, note, ok, warn } from "../log.ts";
import { HOSTING_PROVIDER_IDS, isTarget } from "../providers.ts";
import {
  computedSecrets,
  emailSecretNames,
  MINT_JWK,
  MINT_LOCALLY,
  serviceSecretValue,
  type ComputedSecret,
} from "../secrets.ts";
import { isInvalidSecret, isMissingOrPlaceholder, readEnvFile } from "../util.ts";
import { runInit } from "./init.ts";

export function adminGrantEmails(adminGrants: string | undefined): string {
  return (adminGrants ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.lastIndexOf(":");
      return (separator === -1 ? entry : entry.slice(0, separator)).trim();
    })
    .filter((principal) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(principal))
    .join(",");
}

export function mintSigningJwk(): string {
  return JSON.stringify(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }));
}

const PLAYBOOKS: Readonly<Record<string, readonly string[]>> = {
  ANTHROPIC_API_KEY: [
    "Create an API key at https://console.anthropic.com/settings/keys",
    "(any workspace works; the key starts with sk-ant-).",
    "Only one provider key is needed — set the one whose model you want as the base model.",
  ],
  OPENAI_API_KEY: [
    "Create an API key at https://platform.openai.com/api-keys",
    "(the key starts with sk-).",
    "Only one provider key is needed — set the one whose model you want as the base model.",
  ],
  OPENROUTER_API_KEY: [
    "Create an API key at https://openrouter.ai/settings/keys",
    "(the key starts with sk-or-).",
    "Only one provider key is needed — set the one whose model you want as the base model.",
  ],
  SLACK_BOT_TOKEN: [
    "Create the Slack app from the scaffolded manifest:",
    "  1. Open https://api.slack.com/apps -> Create New App -> From a manifest.",
    "  2. Pick your workspace and paste the contents of <manifest>.",
    "  3. On Install App, install it to the workspace.",
    "  4. Copy the Bot User OAuth Token (starts with xoxb-).",
  ],
  SLACK_APP_TOKEN: [
    "On the same Slack app's Basic Information page, under App-Level Tokens:",
    "Generate a token with the connections:write scope (starts with xapp-).",
  ],
  SLACK_SIGNING_SECRET: ["On the Slack app's Basic Information page, copy the Signing Secret."],
  ADMIN_GRANTS: [
    "Enter the verified email for the first qm administrator",
    "followed by :org_admin, for example admin@example.com:org_admin.",
  ],
  AUTH_ALLOWED_EMAILS: [
    "The email addresses allowed to sign in, comma-separated. Everyone else is",
    "refused, both when a link is requested and again when one is opened.",
    "Set env.auth.AUTH_ALLOWED_EMAIL_DOMAIN in the config instead to admit a whole domain.",
  ],
  AUTH_EMAIL_FROM: [
    "The verified sender sign-in links come from, for example",
    "Acme <no-reply@acme.com>. It must be a domain your email provider has verified.",
  ],
  RESEND_API_KEY: [
    "Create an API key at https://resend.com/api-keys with send access, and verify",
    "the sending domain under Domains (the key starts with re_). Domain",
    "verification needs DNS records — nothing sends until it is green.",
  ],
  SMTP_HOST: [
    "The hostname of your SMTP relay, e.g. smtp.postmarkapp.com,",
    "email-smtp.us-east-1.amazonaws.com, or smtp.sendgrid.net.",
    "Port and TLS are non-secret and live in the config, not here:",
    "env.auth.SMTP_PORT defaults to 587, and env.auth.SMTP_TLS defaults to",
    '"implicit" on port 465 and "starttls" otherwise. "none" is refused in',
    "production, and a relay that does not offer STARTTLS is refused rather",
    "than sent your credentials in cleartext.",
  ],
  SMTP_USERNAME: ["The SMTP username for that relay (for SES, the SMTP credential, not an AWS access key)."],
  SMTP_PASSWORD: ["The SMTP password for that relay."],
  OIDC_CLIENT_ID: [
    'Only for an external identity provider (drop "auth" from services to use one).',
    "Create a Web OAuth/OIDC client in your chosen provider and register",
    "<public-url>/auth/callback as its exact redirect URI, then copy its Client ID.",
  ],
  OIDC_CLIENT_SECRET: ["Only for an external identity provider: the Client Secret of the same OAuth/OIDC client."],
  PORTAL_EXPECTED_TEAM_ID: [
    "Copy the Slack workspace ID from the workspace About dialog or the team_id",
    "returned after installing the Slack sign-in app.",
  ],
  PUBLIC_API_URL: [
    "The public URL agent sandboxes use to reach core's self-API. For docker this",
    "is usually a tunnel or LAN address; for fly/aws it matches your apiUrl when",
    "configured (split-hostname stacks), otherwise your publicUrl.",
  ],
  FLY_SANDBOX_API_TOKEN: [
    "A Fly deploy token scoped to the agent-computer app <sandbox-app>.",
    "Create the app first if it does not exist: fly apps create <sandbox-app>",
  ],
  FLY_DEPLOY_API_TOKEN: [
    "Required only when env.core.DEPLOY_PROVIDER is explicitly set to fly.",
    "A separate Fly organization token for qm's per-deployment apps.",
    "Scope it to the configured organization <fly-org>; do not reuse a personal token.",
  ],
  GOOGLE_OAUTH_CLIENT_SECRET: ["From your Google Cloud OAuth client (APIs & Services -> Credentials)."],
  DROPBOX_OAUTH_CLIENT_SECRET: ["From your Dropbox app console (https://www.dropbox.com/developers/apps)."],
  LINEAR_OAUTH_CLIENT_SECRET: ["From your Linear OAuth application settings."],
};

const FORMAT_HINTS: Readonly<Record<string, { prefix: string; label: string }>> = {
  ANTHROPIC_API_KEY: { prefix: "sk-ant-", label: "Anthropic keys usually start with sk-ant-" },
  OPENAI_API_KEY: { prefix: "sk-", label: "OpenAI keys usually start with sk-" },
  OPENROUTER_API_KEY: { prefix: "sk-or-", label: "OpenRouter keys usually start with sk-or-" },
  SLACK_BOT_TOKEN: { prefix: "xoxb-", label: "bot tokens start with xoxb-" },
  SLACK_APP_TOKEN: { prefix: "xapp-", label: "app-level tokens start with xapp-" },
};

export function playbookFor(name: string, config: QmConfig): string[] {
  const lines = PLAYBOOKS[name];
  if (!lines) return [];
  const app = config.sandbox?.app ?? "<sandbox-app>";
  const flyOrg = config.flyOrg ?? "<fly-org>";
  return lines.map((line) =>
    line
      .replaceAll("<sandbox-app>", app)
      .replaceAll("<fly-org>", flyOrg)
      .replaceAll("<public-url>", config.publicUrl.replace(/\/$/, ""))
      .replaceAll("<manifest>", "slack-app-manifest.yml"),
  );
}

export function pendingSecrets(
  config: QmConfig,
  env: Map<string, string>,
  includeEmail = false,
): { todo: ComputedSecret[]; done: ComputedSecret[] } {
  const emailNames = includeEmail
    ? emailSecretNames(config)
        .filter((name) => isMissingOrPlaceholder(config.env.auth?.[name]))
        .map((name) => config.secretEnv?.auth?.[name] ?? name)
    : [];
  const operator = computedSecrets(config).filter(
    (secret) => secret.managedBy === "operator" && (secret.required || emailNames.includes(secret.name)),
  );
  const todo = operator.filter((secret) => isInvalidSecret(secret.name, env.get(secret.name)));
  const done = operator.filter((secret) => !isInvalidSecret(secret.name, env.get(secret.name)));
  todo.sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
  return { todo, done };
}

export function updateEnvContent(content: string, entries: ReadonlyMap<string, string>): string {
  const remaining = new Map(entries);
  const lines = content.split("\n").map((line) => {
    const match = /^(#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    const name = match?.[2];
    if (!name || !remaining.has(name)) return line;
    const value = remaining.get(name)!;
    remaining.delete(name);
    return `${name}=${value}`;
  });
  let out = lines.join("\n");
  if (remaining.size > 0) {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
    for (const [name, value] of remaining) out += `${name}=${value}\n`;
  }
  return out;
}

function makePrompter(): {
  rl: Interface;
  ask: (q: string) => Promise<string>;
  askHidden: (q: string) => Promise<string>;
} {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();
  const askHidden = async (q: string): Promise<string> => {
    process.stdout.write(q);
    muted = true;
    try {
      const answer = await rl.question("");
      process.stdout.write("\n");
      return answer.trim();
    } finally {
      muted = false;
    }
  };
  return { rl, ask, askHidden };
}

export async function runSetup(opts: { dir: string }): Promise<void> {
  if (process.stdin.isTTY !== true) {
    die("setup is an interactive wizard — run it in a terminal (scripted setups edit .env directly; see .env.example)");
  }
  const { rl, ask, askHidden } = makePrompter();
  try {
    const dir = opts.dir;
    let configPath = configPathInDir(dir) ?? join(dir, CONFIG_FILENAME);

    if (!configPathInDir(dir)) {
      header("New deployment");
      note("No QM deployment config here — let's create one.");
      let orgId = "";
      while (!validOrgId(orgId)) {
        orgId = await ask("Organization id (lowercase DNS label, e.g. acme): ");
        if (!validOrgId(orgId)) warn("must be lowercase letters, digits, and inner hyphens");
      }
      let target: Target | undefined;
      while (target === undefined) {
        const answer = (await ask(`Deploy target — ${HOSTING_PROVIDER_IDS.join(", ")} [docker]: `)) || "docker";
        if (isTarget(answer)) target = answer;
        else warn(`answer ${HOSTING_PROVIDER_IDS.join(", ")}`);
      }
      note("");
      runInit({ dir, org: orgId, target });
      configPath = join(dir, CONFIG_FILENAME);
      note("");
    }

    const config = loadConfigAt(configPath).config;
    const envPath = join(dir, ".env");
    const env = readEnvFile(envPath);
    const emailNames = emailSecretNames(config);
    const includeEmail =
      emailNames.length > 0 &&
      (emailNames.some((name) => serviceSecretValue(config, "auth", name, env)?.trim()) ||
        /^y/i.test(await ask("Set up sign-in email now? Admins can use qm admin-login without email. [y/N]: ")));
    const { todo, done } = pendingSecrets(config, env, includeEmail);

    header(`Secrets for org ${config.orgId} (target ${config.target})`);
    if (done.length > 0) ok(`${done.length} already set in .env — skipping: ${done.map((s) => s.name).join(", ")}`);
    if (todo.length === 0) {
      ok("every secret this configuration needs is already set");
    } else {
      note(
        `${todo.length} to collect. Paste each value when prompted (input is hidden); press Enter to skip one and come back later — setup is safe to re-run.\n`,
      );
    }

    const collected = new Map<string, string>();
    const skipped: string[] = [];
    for (const secret of todo) {
      note(`${bold(secret.name)} ${dim(`(${secret.services.join(", ")})`)}`);
      note(`  ${secret.description}`);
      for (const line of playbookFor(secret.name, config)) note(`  ${dim(line)}`);

      if (secret.generate === MINT_LOCALLY) {
        collected.set(secret.name, randomBytes(32).toString("hex"));
        ok(`  generated locally\n`);
        continue;
      }

      if (secret.generate === MINT_JWK) {
        collected.set(secret.name, mintSigningJwk());
        ok(`  generated locally\n`);
        continue;
      }

      if (secret.name === "AUTH_ALLOWED_EMAILS") {
        const derived = adminGrantEmails(collected.get("ADMIN_GRANTS") ?? env.get("ADMIN_GRANTS"));
        if (derived) {
          collected.set(secret.name, derived);
          ok(`  derived from ADMIN_GRANTS: ${derived}\n`);
          continue;
        }
      }

      let value = "";
      value = await askHidden(`  ${secret.name}: `);
      if (value === "") {
        skipped.push(secret.name);
        warn(`  skipped — required before \`up\`; re-run setup to fill it\n`);
        continue;
      }
      const hint = FORMAT_HINTS[secret.name];
      if (hint && !value.startsWith(hint.prefix)) {
        const keep = await ask(`  that doesn't look right (${hint.label}) — keep it anyway? [y/N] `);
        if (!/^y/i.test(keep)) {
          skipped.push(secret.name);
          note("");
          continue;
        }
      }
      collected.set(secret.name, value);
      ok("  saved\n");
    }

    if (collected.size > 0) {
      const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
      writeFileSync(envPath, updateEnvContent(existing, collected), { mode: 0o600 });
      chmodSync(envPath, 0o600);
      ok(`wrote ${collected.size} value${collected.size === 1 ? "" : "s"} to .env`);
    }

    header("Next");
    const remainingRequired = todo.filter((s) => !collected.has(s.name)).map((s) => s.name);
    const stepLine = (n: number, cmd: string, why: string): void =>
      note(`  ${n}. ${cmd.padEnd(24)} ${dim(`# ${why}`)}`);
    let n = 1;
    if (remainingRequired.length > 0) stepLine(n++, "qm setup", `still missing: ${remainingRequired.join(", ")}`);
    stepLine(n++, "qm check", "validate the config and sandbox layer");
    stepLine(n++, "qm doctor", "verify external prerequisites read-only");
    if (config.target === "aws")
      stepLine(n++, "see AGENTS.md", "the AWS bootstrap order (Terraform, TLS, portal) before up");
    else stepLine(n++, "qm up", "bring the deployment up and print the URLs");
    if (skipped.length > 0 && remainingRequired.length === 0) note(dim(`  (optional skipped: ${skipped.join(", ")})`));
  } finally {
    rl.close();
  }
}
