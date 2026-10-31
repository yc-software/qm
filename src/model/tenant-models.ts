import type { Keychain } from "../credentials/keychain.ts";
import { keychainEnvCredential } from "../credentials/keychain-env-credential.ts";
import { currentTenant } from "../tenants/context.ts";
import type { TenantSettings, TenantSettingsStore } from "../tenants/settings.ts";
import { errMessage } from "../util/errors.ts";
import { isClaudeSubscriptionToken } from "./claude-subscription.ts";
import { keychainCompanyChatGPTAuth, type CompanyChatGPTAuth } from "./company-chatgpt-auth.ts";
import { createGatewayCatalog } from "./gateway-catalog.ts";
import { setGatewayModels } from "./gateway-models.ts";
import type { ProviderKeys } from "./model-runtime.ts";
import {
  CODEX_SUBSCRIPTION_PROVIDER,
  DEFAULT_CODEX_MODEL_ID,
  defaultModel,
  onlyProvider,
  type ModelProvider,
  type ModelProviderAvailability,
} from "./pi-models.ts";
import type { ModelGatewayTransportConfig } from "./provider-endpoints.ts";

const NO_DIRECT_KEYS: ModelProviderAvailability = { anthropic: false, openai: false, openrouter: false };

export function companySubscriptionAuthFor(
  settings: TenantSettings,
  anthropicKey?: string | null,
): ModelProvider | undefined {
  if (anthropicKey ? isClaudeSubscriptionToken(anthropicKey) : settings.claudeAuthCredential) return "anthropic";
  return settings.codexAuthCredential ? "openai" : undefined;
}

export function configuredModelFor(
  settings: TenantSettings,
  direct: ModelProviderAvailability = NO_DIRECT_KEYS,
): string | undefined {
  if (
    !settings.piModel &&
    !settings.modelProvider &&
    !direct.anthropic &&
    !settings.claudeAuthCredential &&
    settings.codexAuthCredential
  )
    return DEFAULT_CODEX_MODEL_ID;
  return settings.piModel;
}

export function defaultModelFor(
  settings: TenantSettings,
  gateway?: ModelGatewayTransportConfig,
  direct: ModelProviderAvailability = NO_DIRECT_KEYS,
): string {
  const configured = configuredModelFor(settings, direct);
  if (settings.modelProvider) return defaultModel(configured, onlyProvider(settings.modelProvider));
  return defaultModel(
    configured,
    gateway
      ? {
          anthropic: direct.anthropic,
          openai: direct.openai,
          openrouter: direct.openrouter,
          ...(settings.codexAuthCredential ? { codexOAuth: true } : {}),
          modelIds: new Set(Object.keys(gateway.models)),
        }
      : undefined,
  );
}

export interface TenantModels {
  gateway(): Promise<ModelGatewayTransportConfig | undefined>;
  defaultModel(): string;
  noteDirectKeys(tenant: string, direct: ModelProviderAvailability): void;
  subscriptionAuth(): Promise<ModelProvider | undefined>;
  subscriptionKeys(): Promise<ProviderKeys>;
}

export function createTenantModels(deps: {
  settings: TenantSettingsStore;
  keychain: () => Keychain | undefined;
  fetch?: typeof fetch;
  anthropicKey: () => Promise<string | null>;
}): TenantModels {
  const gateways = new Map<string, { fingerprint: string; transport: ModelGatewayTransportConfig }>();
  const chatgpt = new Map<string, { credentialId: string; auth: CompanyChatGPTAuth }>();
  const directKeys = new Map<string, ModelProviderAvailability>();

  function gatewayFor(tenant: string, settings: TenantSettings): ModelGatewayTransportConfig | undefined {
    if (!settings.modelGateway) {
      if (gateways.delete(tenant)) setGatewayModels([]);
      return undefined;
    }
    const fingerprint = JSON.stringify(settings.modelGateway);
    const known = gateways.get(tenant);
    if (known?.fingerprint === fingerprint) return known.transport;
    const transport = createGatewayCatalog(settings.modelGateway, deps.fetch, Date.now, (models, aliases) => {
      if (gateways.get(tenant)?.transport === transport) setGatewayModels(models, aliases);
    }).transport;
    gateways.set(tenant, { fingerprint, transport });
    return transport;
  }

  function companyAuth(tenant: string, credentialId: string | undefined): CompanyChatGPTAuth | undefined {
    const keychain = deps.keychain();
    if (!credentialId || !keychain) return undefined;
    const known = chatgpt.get(tenant);
    if (known?.credentialId === credentialId) return known.auth;
    const auth = keychainCompanyChatGPTAuth({ keychain, credentialId });
    chatgpt.set(tenant, { credentialId, auth });
    return auth;
  }

  async function chatgptKeys(settings: TenantSettings): Promise<ProviderKeys> {
    const auth = companyAuth(currentTenant(), settings.codexAuthCredential);
    if (!auth) return {};
    try {
      const token = await auth.accessToken();
      return token ? { [CODEX_SUBSCRIPTION_PROVIDER]: token } : {};
    } catch (e) {
      console.error(`[model] company ChatGPT auth (${auth.description}) unreadable: ${errMessage(e)}`);
      return {};
    }
  }

  async function claudeKeys(settings: TenantSettings): Promise<ProviderKeys> {
    const keychain = deps.keychain();
    if (!settings.claudeAuthCredential || !keychain) return {};
    const env = await keychainEnvCredential(keychain, settings.claudeAuthCredential, [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
    ])();
    const token = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
    if (!token)
      console.error(
        `[model] company Claude subscription credential ${settings.claudeAuthCredential} yielded no token (missing, expired, or not an env credential)`,
      );
    return token ? { anthropic: token } : {};
  }

  return {
    async gateway() {
      return gatewayFor(currentTenant(), await deps.settings.get());
    },
    defaultModel() {
      const settings = deps.settings.peek();
      const tenant = currentTenant();
      return defaultModelFor(settings, gatewayFor(tenant, settings), directKeys.get(tenant));
    },
    noteDirectKeys(tenant, direct) {
      directKeys.set(tenant, { anthropic: direct.anthropic, openai: direct.openai, openrouter: direct.openrouter });
    },
    async subscriptionAuth() {
      return companySubscriptionAuthFor(await deps.settings.get(), await deps.anthropicKey());
    },
    async subscriptionKeys() {
      const settings = await deps.settings.get();
      const [claude, codex] = await Promise.all([claudeKeys(settings), chatgptKeys(settings)]);
      return { ...claude, ...codex };
    },
  };
}
