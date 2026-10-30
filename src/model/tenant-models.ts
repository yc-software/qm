import type { Keychain } from "../credentials/keychain.ts";
import { keychainHarnessAuthEnv } from "../credentials/harness-auth-env.ts";
import { boundTenant, currentTenant } from "../tenants/context.ts";
import type { TenantSettings, TenantSettingsStore } from "../tenants/settings.ts";
import { errMessage } from "../util/errors.ts";
import { keychainCompanyChatGPTAuth, type CompanyChatGPTAuth } from "./company-chatgpt-auth.ts";
import { createGatewayCatalog } from "./gateway-catalog.ts";
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

export function configuredModelFor(settings: TenantSettings, harness: string): string | undefined {
  if (harness === "claude") return settings.claudeModel;
  if (harness === "pi" && !settings.piModel && !settings.modelProvider && settings.codexAuthCredential)
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
): string {
  const configured = configuredModelFor(settings, harness);
  if (settings.modelProvider)
    return defaultModelForHarness(harness, configured, onlyProvider(settings.modelProvider));
  const providers: ModelProviderAvailability | undefined =
    harness === "pi" && gateway
      ? {
          anthropic: false,
          openai: false,
          openrouter: false,
          ...(settings.codexAuthCredential ? { codexOAuth: true } : {}),
          modelIds: new Set(Object.keys(gateway.models)),
        }
      : undefined;
  return defaultModelForHarness(harness, configured, providers);
}

export interface TenantModels {
  gateway(): Promise<ModelGatewayTransportConfig | undefined>;
  gatewaySnapshot(): ModelGatewayTransportConfig | undefined;
  defaultModel(harness: string): string;
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

  function gatewayFor(tenant: string, settings: TenantSettings): ModelGatewayTransportConfig | undefined {
    if (!settings.modelGateway) {
      gateways.delete(tenant);
      return undefined;
    }
    const fingerprint = JSON.stringify(settings.modelGateway);
    const known = gateways.get(tenant);
    if (known?.fingerprint === fingerprint) return known.transport;
    const transport = createGatewayCatalog(settings.modelGateway, deps.fetch).transport;
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
    gatewaySnapshot() {
      const tenant = boundTenant();
      return tenant ? gateways.get(tenant)?.transport : undefined;
    },
    defaultModel(harness) {
      const settings = deps.settings.peek();
      return defaultModelFor(settings, harness, gatewayFor(currentTenant(), settings));
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
