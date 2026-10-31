import {
  parseProviderBaseUrl,
  type ModelGatewayTransportConfig,
  type ProviderBaseUrls,
} from "../model/provider-endpoints.ts";
import {
  MODEL_PROVIDERS,
  defaultModelForProvider,
  isModelProvider,
  resolveModel,
  type ModelProvider,
} from "../model/pi-models.ts";
import type { SandboxBackendName } from "../sandbox/sandbox-routing.ts";
import { SECURITY_SCREEN_MODES, type SecurityScreenMode } from "../security/security-posture.ts";
import type { TenantSettingValues } from "./settings.ts";

export interface SecurityScreenProxySettings {
  provider: string;
  endpoint: string;
  token: string;
}

export interface TenantSettings {
  readonly values: Readonly<TenantSettingValues>;
  readonly modelProvider?: ModelProvider;
  readonly piModel?: string;
  readonly piDetectModel?: string;
  readonly piTitleModel?: string;
  readonly piJudgeModel?: string;
  readonly providerBaseUrls: ProviderBaseUrls;
  readonly modelGateway?: ModelGatewayTransportConfig;
  readonly codexAuthCredential?: string;
  readonly claudeAuthCredential?: string;
  readonly sandboxBackend?: SandboxBackendName;
  readonly securityScreen: SecurityScreenMode;
  readonly securityScreenClassifier: "model" | "proxy";
  readonly securityScreenProxy?: SecurityScreenProxySettings;
  readonly emailAuthPrincipals: readonly string[];
  readonly emailAuthDomain?: string;
  readonly trustedOidcAdminIssuer?: string;
  readonly suggestedActivitiesContext?: string;
}

export const SANDBOX_BACKEND_NAMES = [
  "local",
  "sprites",
  "smolmachines",
  "e2b",
  "modal",
  "do-managed-agents",
  "render",
] as const satisfies readonly SandboxBackendName[];

export function parseSandboxBackend(name: string, value: string): SandboxBackendName {
  const backend = value.trim();
  if ((SANDBOX_BACKEND_NAMES as readonly string[]).includes(backend)) return backend as SandboxBackendName;
  throw new Error(
    `${name}=${JSON.stringify(value)} is not recognized — use ${SANDBOX_BACKEND_NAMES.join(", ")}, or unset it.`,
  );
}

export function parseChoice<T extends string>(name: string, value: string | undefined, choices: readonly T[]): T {
  if (value === undefined || value.trim() === "") return choices[0]!;
  const choice = value.trim().toLowerCase();
  if ((choices as readonly string[]).includes(choice)) return choice as T;
  throw new Error(`${name}=${JSON.stringify(value)} is not recognized — use ${choices.join(", ")}, or unset it.`);
}

export function parseModelGateway(values: TenantSettingValues): ModelGatewayTransportConfig | undefined {
  const names = [
    "MODEL_GATEWAY_URL",
    "MODEL_GATEWAY_API_KEY",
    "MODEL_GATEWAY_API_KEY_HEADER",
    "MODEL_GATEWAY_MODELS",
  ] as const;
  if (!names.some((name) => values[name]?.trim())) return undefined;
  for (const name of names.filter((name) => name !== "MODEL_GATEWAY_MODELS")) {
    if (!values[name]?.trim()) throw new Error(`${name} is required when model gateway routing is configured`);
  }
  const apiKeyHeader = values.MODEL_GATEWAY_API_KEY_HEADER!.trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(apiKeyHeader)) {
    throw new Error("MODEL_GATEWAY_API_KEY_HEADER must be a valid HTTP header name");
  }
  const models: Record<string, string> = {};
  for (const mapping of values.MODEL_GATEWAY_MODELS?.trim() ? values.MODEL_GATEWAY_MODELS.split(",") : []) {
    const separator = mapping.indexOf("=");
    const source = mapping.slice(0, separator).trim();
    const target = mapping.slice(separator + 1).trim();
    if (separator < 1 || !source || !target) throw new Error(`invalid MODEL_GATEWAY_MODELS mapping: ${mapping}`);
    if (models[source]) throw new Error(`duplicate MODEL_GATEWAY_MODELS source: ${source}`);
    models[source] = target;
  }
  const unsupported = Object.keys(models).filter((id) => !resolveModel(id, false));
  if (unsupported.length)
    throw new Error(`MODEL_GATEWAY_MODELS contains unsupported models: ${unsupported.join(", ")}`);
  return {
    url: parseProviderBaseUrl("MODEL_GATEWAY_URL", values.MODEL_GATEWAY_URL!),
    apiKey: values.MODEL_GATEWAY_API_KEY!,
    apiKeyHeader,
    models,
  };
}

function parseModelProvider(value: string | undefined): ModelProvider | undefined {
  const declared = value?.trim();
  if (!declared) return undefined;
  if (!isModelProvider(declared)) {
    throw new Error(
      `MODEL_PROVIDER=${JSON.stringify(declared)} is not recognized — use ${MODEL_PROVIDERS.join(", ")}.`,
    );
  }
  if (!defaultModelForProvider(declared)) {
    throw new Error(
      `MODEL_PROVIDER=${declared} cannot serve a base model — no ${declared} model is available, so every turn would be refused.`,
    );
  }
  return declared;
}

function parseProviderBaseUrls(values: TenantSettingValues): ProviderBaseUrls {
  const urls: ProviderBaseUrls = {};
  if (values.ANTHROPIC_BASE_URL) urls.anthropic = parseProviderBaseUrl("ANTHROPIC_BASE_URL", values.ANTHROPIC_BASE_URL);
  if (values.OPENAI_BASE_URL) urls.openai = parseProviderBaseUrl("OPENAI_BASE_URL", values.OPENAI_BASE_URL);
  if (values.OPENROUTER_BASE_URL)
    urls.openrouter = parseProviderBaseUrl("OPENROUTER_BASE_URL", values.OPENROUTER_BASE_URL);
  return urls;
}

function parseSecurityScreenProxy(
  classifier: "model" | "proxy",
  values: TenantSettingValues,
): SecurityScreenProxySettings | undefined {
  const provider = values.SECURITY_SCREEN_PROXY_PROVIDER?.trim();
  const endpoint = values.SECURITY_SCREEN_PROXY_ENDPOINT?.trim();
  const token = values.SECURITY_SCREEN_PROXY_TOKEN?.trim();
  if (classifier !== "proxy") {
    if (provider || endpoint || token)
      throw new Error("SECURITY_SCREEN_PROXY_* requires SECURITY_SCREEN_CLASSIFIER=proxy");
    return undefined;
  }
  if (!provider || !endpoint || !token) {
    throw new Error(
      "SECURITY_SCREEN_CLASSIFIER=proxy requires SECURITY_SCREEN_PROXY_PROVIDER, SECURITY_SCREEN_PROXY_ENDPOINT, and SECURITY_SCREEN_PROXY_TOKEN",
    );
  }
  if (provider.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(provider)) {
    throw new Error("SECURITY_SCREEN_PROXY_PROVIDER must be a lowercase DNS label");
  }
  if (provider === "surface" || provider === "origin") {
    throw new Error("SECURITY_SCREEN_PROXY_PROVIDER must not collide with a security screen metadata field");
  }
  let url: URL | undefined;
  try {
    url = new URL(endpoint);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash || url.hostname.endsWith(".")) {
    throw new Error(
      "SECURITY_SCREEN_PROXY_ENDPOINT must be an HTTPS URL without credentials, a fragment, or a trailing hostname dot",
    );
  }
  return { provider, endpoint, token };
}

function emailList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined || value === "" ? {} : ({ [key]: value } as Record<K, V>);
}

export function parseTenantSettings(values: TenantSettingValues): TenantSettings {
  const securityScreenClassifier = parseChoice("SECURITY_SCREEN_CLASSIFIER", values.SECURITY_SCREEN_CLASSIFIER, [
    "model",
    "proxy",
  ] as const);
  const domain = values.AUTH_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase();
  return {
    values: Object.freeze({ ...values }),
    ...optional("modelProvider", parseModelProvider(values.MODEL_PROVIDER)),
    ...optional("piModel", values.PI_MODEL),
    ...optional("piDetectModel", values.PI_DETECT_MODEL),
    ...optional("piTitleModel", values.PI_TITLE_MODEL),
    ...optional("piJudgeModel", values.PI_JUDGE_MODEL),
    providerBaseUrls: parseProviderBaseUrls(values),
    ...optional("modelGateway", parseModelGateway(values)),
    ...optional("codexAuthCredential", values.CODEX_AUTH_CREDENTIAL?.trim()),
    ...optional("claudeAuthCredential", values.CLAUDE_AUTH_CREDENTIAL?.trim()),
    ...optional(
      "sandboxBackend",
      values.SANDBOX_BACKEND ? parseSandboxBackend("SANDBOX_BACKEND", values.SANDBOX_BACKEND) : undefined,
    ),
    securityScreen: parseChoice("SECURITY_SCREEN", values.SECURITY_SCREEN, SECURITY_SCREEN_MODES),
    securityScreenClassifier,
    ...optional("securityScreenProxy", parseSecurityScreenProxy(securityScreenClassifier, values)),
    emailAuthPrincipals: emailList(values.AUTH_ALLOWED_EMAILS),
    ...optional("emailAuthDomain", domain),
    ...optional("trustedOidcAdminIssuer", values.TRUSTED_OIDC_ADMIN_ISSUER?.trim()),
    ...optional("suggestedActivitiesContext", values.SUGGESTED_ACTIVITIES_CONTEXT?.slice(0, 8000)),
  };
}
