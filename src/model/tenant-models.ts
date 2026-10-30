import type { Keychain } from "../credentials/keychain.ts";
import { keychainHarnessAuthEnv } from "../credentials/harness-auth-env.ts";
import { currentTenant } from "../tenants/context.ts";
import type { TenantSettings, TenantSettingsStore } from "../tenants/settings.ts";
import { errMessage } from "../util/errors.ts";
import { keychainCompanyChatGPTAuth, type CompanyChatGPTAuth } from "./company-chatgpt-auth.ts";
import { createGatewayCatalog } from "./gateway-catalog.ts";
import { setGatewayModels } from "./gateway-models.ts";
import {
  CODEX_SUBSCRIPTION_PROVIDER,
  DEFAULT_CODEX_MODEL_ID,
  defaultModelForHarness,
  onlyProvider,
  type ModelProvider,
  type ModelProviderAvailability,
} from "./pi-models.ts";
import type { ProviderKeys } from "../harness/pi-harness.ts";
import type { ModelGatewayTransportConfig } from "./provider-endpoints.ts";

const NO_DIRECT_KEYS: ModelProviderAvailability = { anthropic: false, openai: false, openrouter: false };

export function configuredModelFor(
  settings: TenantSettings,
  harness: string,
  direct: ModelProviderAvailability = NO_DIRECT_KEYS,
): string | undefined {
  if (harness === "claude") return settings.claudeModel;
  if (
    harness === "pi" &&
    !settings.piModel &&
    !settings.modelProvider &&
    !direct.anthropic &&
    settings.codexAuthCredential
  )
    return DEFAULT_CODEX_MODEL_ID;
  return settings.piModel;
}

export function harnessCarriedModelAuthFor(settings: TenantSettings, harness: string): ModelProvider | undefined {
  if (harness === "claude" && settings.claudeAuthCredential) return "anthropic";
  return settings.codexAuthCredential ? "openai" : undefined;
}

export function defaultModelFor(
  settings: TenantSettings,
  harness: string,
  gateway?: ModelGatewayTransportConfig,
  direct: ModelProviderAvailability = NO_DIRECT_KEYS,
): string {
  const configured = configuredModelFor(settings, harness, direct);
  if (settings.modelProvider) return defaultModelForHarness(harness, configured, onlyProvider(settings.modelProvider));
  const providers: ModelProviderAvailability | undefined =
    harness === "pi" && gateway
      ? {
          anthropic: direct.anthropic,
          openai: direct.openai,
          openrouter: direct.openrouter,
          ...(settings.codexAuthCredential ? { codexOAuth: true } : {}),
          modelIds: new Set(Object.keys(gateway.models)),
        }
      : undefined;
  return defaultModelForHarness(harness, configured, providers);
}

export interface TenantModels {
  gateway(): Promise<ModelGatewayTransportConfig | undefined>;
  defaultModel(harness: string): string;
  noteDirectKeys(tenant: string, direct: ModelProviderAvailability): void;
  subscriptionKeys(): Promise<ProviderKeys>;
  claudeAuthEnv(): Promise<NodeJS.ProcessEnv>;
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

  return {
    async gateway() {
      return gatewayFor(currentTenant(), await deps.settings.get());
    },
    defaultModel(harness) {
      const settings = deps.settings.peek();
      const tenant = currentTenant();
      return defaultModelFor(settings, harness, gatewayFor(tenant, settings), directKeys.get(tenant));
    },
    noteDirectKeys(tenant, direct) {
      directKeys.set(tenant, { anthropic: direct.anthropic, openai: direct.openai, openrouter: direct.openrouter });
    },
    async subscriptionKeys() {
      const auth = companyAuth(currentTenant(), (await deps.settings.get()).codexAuthCredential);
      if (!auth) return {};
      try {
        const token = await auth.accessToken();
        return token ? { [CODEX_SUBSCRIPTION_PROVIDER]: token } : {};
      } catch (e) {
        console.error(`[model] company ChatGPT auth (${auth.description}) unreadable: ${errMessage(e)}`);
        return {};
      }
    },
    async claudeAuthEnv() {
      const settings = await deps.settings.get();
      const apiKey = await deps.anthropicKey();
      const keychain = deps.keychain();
      const subscription =
        settings.claudeAuthCredential && keychain
          ? await keychainHarnessAuthEnv(keychain, settings.claudeAuthCredential, [
              "CLAUDE_CODE_OAUTH_TOKEN",
              "ANTHROPIC_AUTH_TOKEN",
            ])()
          : {};
      return {
        ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
        ...(settings.providerBaseUrls.anthropic ? { ANTHROPIC_BASE_URL: settings.providerBaseUrls.anthropic } : {}),
        ...subscription,
      };
    },
  };
}
