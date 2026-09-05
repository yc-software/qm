import { isVirtualService, type DeclaredServiceName } from "./services.ts";
import type { ModelProvider, QmConfig } from "./config.ts";
import { TARGET_ENV_DEFAULTS } from "./target-env-defaults.ts";
import { deploymentSecretValue } from "./util.ts";

type SecretCondition =
  | { kind: "env-equals"; service: DeclaredServiceName; name: string; value: string }
  | { kind: "env-in"; service: DeclaredServiceName; name: string; values: string[] }
  | { kind: "env-absent"; service: DeclaredServiceName; name: string }
  | { kind: "env-all-absent"; service: DeclaredServiceName; names: string[] }
  | { kind: "env-present"; service: DeclaredServiceName; name: string }
  | { kind: "service-enabled"; service: DeclaredServiceName }
  | { kind: "service-absent"; service: DeclaredServiceName }
  | { kind: "all"; conditions: SecretCondition[] }
  | { kind: "any"; conditions: SecretCondition[] }
  | { kind: "target"; target: QmConfig["target"] }
  | { kind: "model-provider"; provider: ModelProvider };

export interface SecretSpec {
  name: string;
  service: DeclaredServiceName;
  envName?: string;
  required: boolean | { when: SecretCondition; optional?: true; optionalOtherwise?: true };
  description: string;
  generate?: string;
  managedBy?: "operator" | "terraform";
}

export interface ComputedSecret {
  name: string;
  services: string[];
  description: string;
  required: boolean;
  generate?: string;
  managedBy: "operator" | "terraform";
  aliases?: Array<{ service: DeclaredServiceName; name: string }>;
}

export const MINT_LOCALLY = "openssl rand -hex 32";
export const MINT_JWK =
  "node -e \"const {generateKeyPairSync}=require('node:crypto');process.stdout.write(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))\"";

export const FIRST_PARTY_SECRET_SPECS: readonly SecretSpec[] = [
  {
    name: "ANTHROPIC_API_KEY",
    service: "core",
    required: { when: { kind: "model-provider", provider: "anthropic" }, optionalOtherwise: true },
    description:
      'Anthropic API key: bills the base model when modelProvider is "anthropic", an optional deployment fallback otherwise.',
  },
  {
    name: "OPENROUTER_API_KEY",
    service: "core",
    required: { when: { kind: "model-provider", provider: "openrouter" }, optionalOtherwise: true },
    description:
      'OpenRouter API key: bills the base model when modelProvider is "openrouter", an optional deployment fallback otherwise.',
  },
  {
    name: "OPENAI_API_KEY",
    service: "core",
    required: {
      when: {
        kind: "any",
        conditions: [
          { kind: "env-equals", service: "core", name: "HARNESS", value: "codex" },
          { kind: "model-provider", provider: "openai" },
        ],
      },
    },
    description:
      'OpenAI API key: the Codex harness needs it (its CLI cannot do browser OAuth in a container), and it bills the base model when modelProvider is "openai".',
  },
  {
    name: "PUBLIC_API_URL",
    service: "core",
    required: { when: { kind: "env-in", service: "core", name: "HARNESS", values: ["pi", "opencode", "codex"] } },
    description: "Public core self-API URL reachable from agent sandboxes.",
  },
  {
    name: "CORE_SIGNING_SECRET",
    service: "core",
    required: true,
    description: "HMAC key shared by core and surface plugins.",
    generate: MINT_LOCALLY,
  },
  {
    name: "CAPABILITY_SECRET",
    service: "core",
    required: true,
    description: "Signing key for scoped agent capabilities and egress grants; must differ from every other key.",
    generate: MINT_LOCALLY,
  },
  {
    name: "PORTAL_IDENTITY_SECRET",
    service: "core",
    required: true,
    description: "Signing key for portal-bound user identity; must differ from every other key.",
    generate: MINT_LOCALLY,
  },
  {
    name: "CONNECTOR_SECRET_KEY",
    service: "core",
    required: true,
    description: "Encryption key for durable connector credentials; must differ from every other key.",
    generate: MINT_LOCALLY,
  },
  {
    name: "SKILL_SIGNING_SECRET",
    service: "core",
    required: true,
    description: "Stable signing key for reviewed skills.",
    generate: MINT_LOCALLY,
  },
  {
    name: "FLY_SANDBOX_API_TOKEN",
    service: "core",
    envName: "FLY_API_TOKEN",
    required: { when: { kind: "target", target: "fly" } },
    description: "Fly deploy token scoped to the agent-computer app.",
    generate: "fly tokens create deploy -a <sandbox-app> -x 8760h",
  },
  {
    name: "FLY_DEPLOY_API_TOKEN",
    service: "core",
    required: { when: { kind: "env-equals", service: "core", name: "DEPLOY_PROVIDER", value: "fly" } },
    description: "Fly organization token used only by qm's opt-in per-deployment app publisher.",
    generate: "fly tokens create org -o <fly-org> -x 8760h",
  },
  {
    name: "PORTER_DEPLOY_API_TOKEN",
    service: "core",
    required: {
      when: {
        kind: "any",
        conditions: [
          { kind: "env-equals", service: "core", name: "SANDBOX_BACKEND", value: "porter" },
          { kind: "env-equals", service: "core", name: "DEPLOY_PROVIDER", value: "porter" },
        ],
      },
    },
    description:
      "Admin-role Porter API token for the sandbox backend and the per-deployment app publisher — Developer-role tokens fail mid-deployment with PERMISSION_DENIED.",
    generate:
      "create an Admin-role API token in the Porter dashboard (https://dashboard.porter.run → Settings → API tokens)",
  },
  {
    name: "SPRITES_TOKEN",
    service: "core",
    required: { when: { kind: "env-equals", service: "core", name: "SANDBOX_BACKEND", value: "sprites" } },
    description: "Fly Sprites API token for the agent-computer substrate.",
    generate: "sprite login   # then copy the token from ~/.sprite/credentials",
  },
  {
    name: "SMOLMACHINES_TOKEN",
    service: "core",
    required: { when: { kind: "env-equals", service: "core", name: "SANDBOX_BACKEND", value: "smolmachines" } },
    description: "smolmachines API key for the agent-computer substrate.",
    generate: "create an API key in the smolmachines console (https://smolmachines.com/console)",
  },
  {
    name: "AGENT37_API_KEY",
    service: "core",
    required: {
      when: {
        kind: "any",
        conditions: [
          { kind: "env-equals", service: "core", name: "SANDBOX_BACKEND", value: "agent37" },
          { kind: "env-equals", service: "core", name: "SANDBOX_SECONDARY_BACKEND", value: "agent37" },
        ],
      },
    },
    description: "Agent37 API key for the agent-computer substrate.",
    generate: "mint a key in the Agent37 dashboard (https://agent37.com/dashboard/cloud/api-keys)",
  },
  {
    name: "DATABASE_URL",
    service: "core",
    required: { when: { kind: "target", target: "aws" } },
    description: "Postgres connection string for durable state.",
    managedBy: "terraform",
  },
  {
    name: "DATABASE_CA_CERT",
    service: "core",
    required: false,
    description:
      "Extra root CA (PEM content) trusted for the Postgres connection, for providers that pin a private root (e.g. Supabase's pooler). Verification stays on.",
  },
  {
    name: "AWS_DEPLOY_GATE_SECRET",
    service: "core",
    required: {
      when: {
        kind: "any",
        conditions: [
          { kind: "env-present", service: "core", name: "AWS_DEPLOY_APPS_DOMAIN" },
          { kind: "env-present", service: "core", name: "DEPLOY_APPS_DOMAIN" },
        ],
      },
    },
    description: "HMAC key protecting public deployment-app URLs on the apps domain.",
    generate: MINT_LOCALLY,
  },
  {
    name: "GOOGLE_OAUTH_CLIENT_SECRET",
    service: "core",
    required: { when: { kind: "env-present", service: "core", name: "GOOGLE_OAUTH_CLIENT_ID" } },
    description: "Google OAuth client secret.",
  },
  {
    name: "DROPBOX_OAUTH_CLIENT_SECRET",
    service: "core",
    required: { when: { kind: "env-present", service: "core", name: "DROPBOX_OAUTH_CLIENT_ID" } },
    description: "Dropbox OAuth client secret.",
  },
  {
    name: "LINEAR_OAUTH_CLIENT_SECRET",
    service: "core",
    required: { when: { kind: "env-present", service: "core", name: "LINEAR_OAUTH_CLIENT_ID" } },
    description: "Linear OAuth client secret.",
  },
  {
    name: "SLACK_BOT_TOKEN",
    service: "slack",
    required: false,
    description: "Optional at first deploy; Slack bot OAuth token.",
  },
  {
    name: "SLACK_APP_TOKEN",
    service: "slack",
    required: false,
    description: "Optional at first deploy; Slack Socket Mode app token.",
  },
  {
    name: "SLACK_SIGNING_SECRET",
    service: "slack",
    required: { when: { kind: "env-equals", service: "slack", name: "SLACK_EVENTS_MODE", value: "http" } },
    description: "Slack request-signing secret (from the Slack app's Basic Information page); HTTP events mode only.",
  },
  {
    name: "CORE_SIGNING_SECRET",
    service: "slack",
    required: true,
    description: "HMAC key shared by core and surface plugins.",
    generate: MINT_LOCALLY,
  },
  {
    name: "CORE_SIGNING_SECRET",
    service: "web-ui",
    required: true,
    description: "HMAC key shared by core and surface plugins.",
    generate: MINT_LOCALLY,
  },
  {
    name: "CORE_SIGNING_SECRET",
    service: "admin",
    required: true,
    description: "HMAC key shared by core and surface plugins.",
    generate: MINT_LOCALLY,
  },
  {
    name: "OIDC_CLIENT_ID",
    service: "portal",
    required: {
      when: {
        kind: "all",
        conditions: [
          { kind: "service-absent", service: "auth" },
          { kind: "env-absent", service: "portal", name: "OIDC_CLIENT_ID" },
        ],
      },
    },
    description: "Deployment-specific OIDC client identifier when it should not be committed.",
  },
  {
    name: "OIDC_CLIENT_SECRET",
    service: "portal",
    required: { when: { kind: "service-absent", service: "auth" } },
    description:
      "Client secret issued by an external identity provider; the built-in auth broker mints its own instead.",
  },
  {
    name: "PORTAL_EXPECTED_TEAM_ID",
    service: "portal",
    required: {
      when: {
        kind: "all",
        conditions: [
          { kind: "service-absent", service: "auth" },
          {
            kind: "env-all-absent",
            service: "portal",
            names: ["OIDC_ALLOWED_EMAILS", "OIDC_ALLOWED_EMAIL_DOMAIN", "PORTAL_EXPECTED_TEAM_ID"],
          },
        ],
      },
    },
    description: "Deployment-specific OIDC workspace trust boundary when it should not be committed.",
  },
  {
    name: "PORTAL_SESSION_SECRET",
    service: "portal",
    required: true,
    description: "Cookie-signing secret for portal sessions.",
    generate: MINT_LOCALLY,
  },
  {
    name: "CORE_SIGNING_SECRET",
    service: "portal",
    required: true,
    description: "HMAC key shared by core and surface plugins.",
    generate: MINT_LOCALLY,
  },
  {
    name: "PORTAL_IDENTITY_SECRET",
    service: "portal",
    required: true,
    description: "Signing key shared with core for portal-bound user identity.",
    generate: MINT_LOCALLY,
  },
  {
    name: "PORTAL_IDENTITY_SECRET",
    service: "web-ui",
    required: true,
    description: "Signing key shared with core for portal-bound user identity.",
    generate: MINT_LOCALLY,
  },
  {
    name: "PORTAL_IDENTITY_SECRET",
    service: "admin",
    required: true,
    description: "Signing key shared with core for portal-bound user identity.",
    generate: MINT_LOCALLY,
  },
  {
    name: "CORE_SIGNING_SECRET",
    service: "auth",
    required: true,
    description: "HMAC key shared by core and surface plugins.",
    generate: MINT_LOCALLY,
  },
  {
    name: "AUTH_SIGNING_JWK",
    service: "auth",
    required: true,
    description:
      "P-256 private JSON Web Key the broker signs id_tokens with; the portal verifies it through the broker's JWKS.",
    generate: MINT_JWK,
  },
  {
    name: "AUTH_TOKEN_SECRET",
    service: "auth",
    required: true,
    description:
      "Key the broker seals sign-in links, authorization codes, and access tokens with; must differ from every other key.",
    generate: MINT_LOCALLY,
  },
  {
    name: "AUTH_CLIENT_SECRET",
    service: "auth",
    required: true,
    description: "Client secret the portal presents to the built-in auth broker; the CLI generates it for both sides.",
    generate: MINT_LOCALLY,
  },
  {
    name: "AUTH_CLIENT_SECRET",
    service: "portal",
    envName: "OIDC_CLIENT_SECRET",
    required: { when: { kind: "service-enabled", service: "auth" } },
    description: "Client secret the portal presents to the built-in auth broker.",
  },
  {
    name: "AUTH_ALLOWED_EMAILS",
    service: "auth",
    required: { when: { kind: "env-absent", service: "auth", name: "AUTH_ALLOWED_EMAIL_DOMAIN" } },
    description: "Comma-separated email addresses allowed to sign in through the built-in broker.",
  },
  {
    name: "AUTH_ALLOWED_EMAILS",
    service: "core",
    required: {
      when: {
        kind: "all",
        conditions: [
          { kind: "service-enabled", service: "auth" },
          { kind: "env-absent", service: "auth", name: "AUTH_ALLOWED_EMAIL_DOMAIN" },
        ],
      },
    },
    description: "Email-auth principals protected from unrelated directory-source deactivation.",
  },
  {
    name: "AUTH_ALLOWED_EMAILS",
    service: "portal",
    envName: "OIDC_ALLOWED_EMAILS",
    required: {
      when: {
        kind: "all",
        conditions: [
          { kind: "service-enabled", service: "auth" },
          { kind: "env-absent", service: "auth", name: "AUTH_ALLOWED_EMAIL_DOMAIN" },
        ],
      },
    },
    description: "Email addresses allowed to sign in; the portal enforces the same list the broker does.",
  },
  {
    name: "AUTH_EMAIL_FROM",
    service: "auth",
    required: false,
    description: 'Verified sender for sign-in links and external-user invitations, e.g. "Acme <no-reply@acme.com>".',
  },
  {
    name: "AUTH_EMAIL_FROM",
    service: "core",
    required: false,
    description:
      "Sender for external-user invitations sent from the admin Users tab or by chatting with QM; the same verified sender the sign-in broker uses.",
  },
  {
    name: "RESEND_API_KEY",
    service: "auth",
    required: {
      when: { kind: "env-equals", service: "auth", name: "AUTH_EMAIL_TRANSPORT", value: "resend" },
      optional: true,
    },
    description: "Resend API key used to deliver sign-in links and external-user invitations.",
  },
  {
    name: "RESEND_API_KEY",
    service: "core",
    required: false,
    description:
      "Lets core email invitations to external users, added from the admin Users tab or by chatting with QM, through Resend.",
  },
  {
    name: "SMTP_HOST",
    service: "auth",
    required: {
      when: { kind: "env-equals", service: "auth", name: "AUTH_EMAIL_TRANSPORT", value: "smtp" },
      optional: true,
    },
    description: "SMTP relay hostname used to deliver sign-in links.",
  },
  {
    name: "SMTP_USERNAME",
    service: "auth",
    required: {
      when: { kind: "env-equals", service: "auth", name: "AUTH_EMAIL_TRANSPORT", value: "smtp" },
      optional: true,
    },
    description: "SMTP username for the sign-in-link relay.",
  },
  {
    name: "SMTP_PASSWORD",
    service: "auth",
    required: {
      when: { kind: "env-equals", service: "auth", name: "AUTH_EMAIL_TRANSPORT", value: "smtp" },
      optional: true,
    },
    description: "SMTP password for the sign-in-link relay.",
  },
];

function conditionMatches(config: QmConfig, condition: SecretCondition): boolean {
  if (condition.kind === "service-enabled") return config.services.includes(condition.service);
  if (condition.kind === "service-absent") return !config.services.includes(condition.service);
  if (condition.kind === "all") return condition.conditions.every((nested) => conditionMatches(config, nested));
  if (condition.kind === "any") return condition.conditions.some((nested) => conditionMatches(config, nested));
  if (condition.kind === "target") return config.target === condition.target;
  if (condition.kind === "model-provider") return config.modelProvider === condition.provider;
  if (condition.kind === "env-all-absent") {
    return condition.names.every((name) => !config.env[condition.service]?.[name]?.trim());
  }
  const configuredSandboxBackend =
    condition.service === "core" && condition.name === "SANDBOX_BACKEND" ? config.sandbox?.backend : undefined;
  const value = (
    config.env[condition.service]?.[condition.name] ??
    configuredSandboxBackend ??
    targetEnvDefault(config, condition.service, condition.name)
  )?.trim();
  if (condition.kind === "env-absent") return !value;
  if (condition.kind === "env-present") return Boolean(value);
  if (condition.kind === "env-in") return value !== undefined && condition.values.includes(value);
  return value === condition.value;
}

function targetEnvDefault(config: QmConfig, service: string, name: string): string | undefined {
  return TARGET_ENV_DEFAULTS[config.target](config, service, name);
}

function requirementFor(config: QmConfig, spec: SecretSpec): boolean | null {
  if (typeof spec.required === "boolean") return spec.required;
  if (conditionMatches(config, spec.required.when)) return !spec.required.optional;
  return spec.required.optionalOtherwise ? false : null;
}

export function emailSecretNames(config: QmConfig): string[] {
  if (!config.services.includes("auth")) return [];
  return [
    "AUTH_EMAIL_FROM",
    ...(config.env.auth?.AUTH_EMAIL_TRANSPORT?.trim() === "smtp"
      ? ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"]
      : ["RESEND_API_KEY"]),
  ];
}

export function computedSecrets(config: QmConfig): ComputedSecret[] {
  const byName = new Map<string, ComputedSecret>();
  for (const spec of FIRST_PARTY_SECRET_SPECS) {
    if (!config.services.includes(spec.service)) continue;
    const required = requirementFor(config, spec);
    if (required === null) continue;
    const current = byName.get(spec.name);
    if (current) {
      if (spec.envName) {
        if (!(current.aliases ?? []).some((alias) => alias.service === spec.service && alias.name === spec.envName)) {
          current.aliases = [...(current.aliases ?? []), { service: spec.service, name: spec.envName }];
        }
      } else if (!current.services.includes(spec.service)) current.services.push(spec.service);
      current.required ||= required;
      continue;
    }
    byName.set(spec.name, {
      name: spec.name,
      services: spec.envName ? [] : [spec.service],
      description: spec.description,
      required,
      ...(spec.generate ? { generate: spec.generate } : {}),
      managedBy: spec.managedBy ?? "operator",
      ...(spec.envName ? { aliases: [{ service: spec.service, name: spec.envName }] } : {}),
    });
  }
  for (const plugin of config.plugins) {
    const signing = byName.get("CORE_SIGNING_SECRET");
    if (signing && !signing.services.includes(plugin.name)) signing.services.push(plugin.name);
    for (const spec of plugin.secrets ?? []) {
      const required = spec.required !== false;
      const current = byName.get(spec.name);
      if (current) {
        if (!current.services.includes(plugin.name)) current.services.push(plugin.name);
        current.required ||= required;
      } else {
        byName.set(spec.name, {
          name: spec.name,
          services: [plugin.name],
          description: spec.description ?? `Secret used by the ${plugin.name} plugin.`,
          required,
          managedBy: "operator",
        });
      }
    }
  }
  for (const [service, entries] of Object.entries(config.secretEnv ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!config.services.includes(service as DeclaredServiceName)) continue;
    for (const [envName, storeName] of Object.entries(entries ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      let current = byName.get(storeName);
      if (!current) {
        current = {
          name: storeName,
          services: [],
          description: `Operator secret declared by config secretEnv.${service}.`,
          required: true,
          managedBy: "operator",
        };
        byName.set(storeName, current);
      }
      current.required = true;
      if (envName === storeName) {
        if (!current.services.includes(service)) current.services.push(service);
      } else if (!(current.aliases ?? []).some((alias) => alias.service === service && alias.name === envName)) {
        current.aliases = [...(current.aliases ?? []), { service: service as DeclaredServiceName, name: envName }];
      }
    }
  }
  for (const name of config.sandbox?.secretEnv ?? []) {
    const current = byName.get(name);
    if (current) {
      current.required = true;
      if (!current.services.includes("sandbox")) current.services.push("sandbox");
    } else {
      byName.set(name, {
        name,
        services: ["sandbox"],
        description: `Organization-wide secret injected into every sandbox as ${name}.`,
        required: true,
        managedBy: "operator",
      });
    }
  }
  return [...byName.values()]
    .map((secret) => ({
      ...secret,
      services: [...secret.services].sort(),
      ...(secret.aliases
        ? {
            aliases: [...secret.aliases].sort(
              (a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name),
            ),
          }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function secretDestinations(
  secret: ComputedSecret,
  pluginNames: readonly string[] = [],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (workload: string, name: string): void => {
    out.set(workload, (out.get(workload) ?? new Set()).add(name));
  };
  for (const service of secret.services) {
    if (service === "sandbox") add("core", `FLY_RESIDENT_ENV_${secret.name}`);
    else if (isVirtualService(service)) add("core", secret.name);
    else add(service, secret.name);
  }
  for (const alias of secret.aliases ?? []) {
    add(isVirtualService(alias.service) ? "core" : alias.service, alias.name);
  }
  if (secret.name === "CORE_SIGNING_SECRET") {
    for (const plugin of pluginNames) add(plugin, secret.name);
  }
  return out;
}

export function runtimeSecretNames(
  workload: string,
  secret: ComputedSecret,
  pluginNames: readonly string[] = [],
): string[] {
  return [...(secretDestinations(secret, pluginNames).get(workload) ?? [])];
}

export function secretsForService(
  config: QmConfig,
  service: string,
  pluginNames: readonly string[] = [],
): ComputedSecret[] {
  return computedSecrets(config).filter((secret) => secretDestinations(secret, pluginNames).has(service));
}

export function serviceSecretValue(
  config: QmConfig,
  service: DeclaredServiceName,
  name: string,
  values: ReadonlyMap<string, string>,
): string | undefined {
  let value = config.env[service]?.[name];
  for (const secret of secretsForService(config, service)) {
    if (!runtimeSecretNames(service, secret).includes(name)) continue;
    const supplied = deploymentSecretValue(secret.name, values.get(secret.name));
    if (supplied !== undefined) value = supplied;
  }
  return value;
}

function requiresOtherEmailTransport(config: QmConfig, condition: SecretCondition): boolean {
  if (condition.kind === "all")
    return condition.conditions.some((nested) => requiresOtherEmailTransport(config, nested));
  if (condition.kind === "any")
    return condition.conditions.every((nested) => requiresOtherEmailTransport(config, nested));
  if (condition.kind !== "env-equals" || condition.service !== "auth" || condition.name !== "AUTH_EMAIL_TRANSPORT")
    return false;
  const configured = config.env.auth?.AUTH_EMAIL_TRANSPORT?.trim();
  return configured !== undefined && configured !== "" && configured !== condition.value;
}

function conditionClause(condition: SecretCondition): string {
  if (condition.kind === "service-enabled") return `the ${condition.service} service is enabled`;
  if (condition.kind === "service-absent") return `the ${condition.service} service is not enabled`;
  if (condition.kind === "all") return condition.conditions.map(conditionClause).join(" and ");
  if (condition.kind === "any") return condition.conditions.map(conditionClause).join(" or ");
  if (condition.kind === "target") return `the target is ${condition.target}`;
  if (condition.kind === "env-all-absent")
    return `none of env.${condition.service}.{${condition.names.join(", ")}} are set`;
  if (condition.kind === "env-absent") return `env.${condition.service}.${condition.name} is not set`;
  if (condition.kind === "env-present") return `env.${condition.service}.${condition.name} is set`;
  if (condition.kind === "env-in")
    return `env.${condition.service}.${condition.name} is one of ${condition.values.map((value) => JSON.stringify(value)).join(", ")}`;
  if (condition.kind === "model-provider") return `modelProvider is ${JSON.stringify(condition.provider)}`;
  return `env.${condition.service}.${condition.name} is ${JSON.stringify(condition.value)}`;
}

export function renderEnvExample(config: QmConfig): string {
  const generate = (command: string): string =>
    command
      .replace("<sandbox-app>", config.sandbox?.app ?? "<sandbox-app>")
      .replace("<fly-org>", config.flyOrg ?? "<fly-org>");
  const lines = [
    "# Secret values for this deployment. This file holds names only; copy it to .env and fill in",
    "# the values. .env is gitignored. `qm secrets push` transfers values without persisting",
    "# or printing them.",
    "",
  ];
  const active = computedSecrets(config);
  for (const secret of active) {
    const consumers = [
      ...new Set([...secret.services, ...(secret.aliases ?? []).map((alias) => alias.service)]),
    ].sort();
    lines.push(`# ${secret.description} (${consumers.join(", ")})`);
    if (secret.generate) lines.push(`# Generate with: ${generate(secret.generate)}`);
    if (secret.managedBy === "terraform") lines.push(`# ${secret.name}=  # populated by Terraform`);
    else if (secret.required) lines.push(`${secret.name}=`);
    else lines.push(`# ${secret.name}=  # optional`);
    lines.push("");
  }
  const activeNames = new Set(active.map((secret) => secret.name));
  const inactive = FIRST_PARTY_SECRET_SPECS.filter(
    (spec, i, all) =>
      !activeNames.has(spec.name) &&
      all.findIndex((other) => other.name === spec.name) === i &&
      !(typeof spec.required === "object" && requiresOtherEmailTransport(config, spec.required.when)),
  );
  for (const spec of inactive) {
    const clauses = [
      ...(config.services.includes(spec.service) ? [] : [`the ${spec.service} service is enabled`]),
      ...(typeof spec.required === "boolean" ? [] : [conditionClause(spec.required.when)]),
    ];
    lines.push(`# ${spec.description} (${spec.service})`);
    lines.push(`# Needed when ${clauses.join(" and ")}${spec.required === false ? " (optional even then)" : ""}.`);
    if (spec.generate) lines.push(`# Generate with: ${generate(spec.generate)}`);
    lines.push(spec.managedBy === "terraform" ? `# ${spec.name}=  # populated by Terraform` : `# ${spec.name}=`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
