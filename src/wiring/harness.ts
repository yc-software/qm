import type { StoresModule } from "./stores.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { Head } from "./late.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "../runs/postgres-run-signal-store.ts";
import {
  resolveModel,
  modelRequestOverrides,
  codexSubscriptionModelId,
  defaultModel,
  auxiliaryModelFor,
  modelSupported,
  resolveEmbeddingModel,
  CODEX_SUBSCRIPTION_PROVIDER,
} from "../model/pi-models.ts";
import { tenant } from "../tenant.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";
import { configuredModel, baseModelProviders, providerKeysPresent } from "../config.ts";
import { createPiHarness, piHarnessConfigOptions } from "../harness/pi-harness.ts";
import { createDecisionHooks, turnStartState, routeTurnRuntime } from "../decisions/hooks.ts";
import { createDecisionBackend } from "../decisions/providers.ts";
import { nonDeploymentCredential } from "../credentials/deployment-credentials.ts";
import { credentialRequestHeaders } from "../credentials/keychain.ts";
import { selectableModelCatalog } from "../model/model-catalog.ts";
import { withResolvedRuntime, resolveRuntimeChoiceDurable } from "../harness/runtime-choice.ts";
import { createGatewayCatalog } from "../model/gateway-catalog.ts";
import { createModelCredentialStore, type ModelCredentialStore } from "../model/model-credential-store.ts";
import { createCustomProviderStore } from "../model/custom-provider-store.ts";
import { setCustomProviders } from "../model/custom-providers.ts";
import { type MemoryEmbedder, createMemoryEmbedder } from "../model/embeddings.ts";
import { reportFailure } from "../util/errors.ts";
import { type CompanyChatGPTAuth, keychainCompanyChatGPTAuth } from "../model/company-chatgpt-auth.ts";
import type { ProviderKeys } from "../harness/pi-model-runtime.ts";
import { keychainHarnessAuthEnv } from "../credentials/harness-auth-env.ts";

type HarnessInputs = Pick<Head, "config" | "overrides" | "connectorSecretKey"> & {
  stores: StoresModule;
  credentials: CredentialsModule;
  deploymentLayer: DeploymentLayerModule;
};

export function buildHarness(deps: HarnessInputs) {
  const { config, overrides } = deps;
  const { databaseUrl, configStore, decisions, every } = deps.stores;
  const { serviceCreds } = deps.credentials;
  const { auditLog } = deps.deploymentLayer;
  const mc = buildModelCredentials(deps);
  const { modelCredentials, gatewayTransport, directProviderAvailability } = mc;
  const {
    resolveMemoryEmbedder,
    resolvePiProviderKeys,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    resolveBrowserCompanyKeys,
  } = buildModelKeys(deps, mc);

  const runSignals: RunSignalStore = createPostgresRunSignalStore(databaseUrl);
  const companyModelId = (id: string): string => {
    if (resolveModel(id)?.provider !== "openai" || modelRequestOverrides(id)) return id;
    const subscription = codexSubscriptionModelId(id);
    return resolveModel(subscription) ? subscription : id;
  };
  const orgBaseModelId = (): string | undefined => configStore.getRuntimeSelection(tenant().orgScope)?.modelId;
  const deploymentDefaultModel = () =>
    defaultModel(
      configuredModel(config),
      baseModelProviders(config) ??
        (gatewayTransport
          ? { ...directProviderAvailability, modelIds: new Set(Object.keys(gatewayTransport.models)) }
          : undefined),
    );
  const pi =
    overrides.harness ??
    createPiHarness({
      ...piHarnessConfigOptions(config),
      modelGateway: gatewayTransport,
      resolveBaseModelId: () => orgBaseModelId() ?? deploymentDefaultModel(),
      resolveFallbackRuntime: () => configStore.getPurposeRuntime("fallback"),
      resolveProviderKeys: resolvePiProviderKeys,
      ...(directProviderAvailability.codexOAuth ? { companyModelId } : {}),
      signals: runSignals,
    });
  const fallback = {
    get modelId() {
      return deploymentDefaultModel();
    },
  };
  const decide = createDecisionHooks(
    decisions,
    createDecisionBackend({
      providers: (ids) => decisions.providers(ids),
      get gateway() {
        const apiKey = tenantConfig(config).modelGatewayApiKey;
        if (!apiKey || !config.modelGateway) return undefined;
        return {
          url: config.modelGateway.url,
          apiKey,
          ...(config.modelGateway.apiKeyHeader ? { apiKeyHeader: config.modelGateway.apiKeyHeader } : {}),
        };
      },
      credential: async (slug) => {
        const rec = nonDeploymentCredential(await serviceCreds.getServiceCredentialSecret(tenant().orgScope, slug));
        return rec ? { host: rec.host, enabled: rec.enabled, headers: credentialRequestHeaders(rec) } : null;
      },
    }),
    auditLog,
  );
  const judgeModelId = (): string => config.judgeModelId ?? auxiliaryModelFor(orgBaseModelId() ?? fallback.modelId);
  const hydrateModelCatalog = async (): Promise<unknown> => {
    await refreshModels();
    if (!(await modelCredentials.availability()).openrouter) return undefined;
    return selectableModelCatalog(overrides.modelCredentialFetch);
  };
  const harness = withResolvedRuntime(pi, async (input, routedBy) => {
    await refreshModels();
    const resolve = (requested: typeof input.runtime) =>
      resolveRuntimeChoiceDurable(
        configStore,
        tenant().orgScope,
        input.scopeLabel,
        fallback,
        requested,
        hydrateModelCatalog,
        input.runtimePurpose,
      );
    const decision = await decide("turn_start", turnStartState(input), {
      ...(input.runtimeActorId ? { actorId: input.runtimeActorId } : {}),
      scopeLabel: input.scopeLabel,
      sessionId: input.session.id,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.cancel ? { cancel: input.cancel } : {}),
    });
    const routed = await routeTurnRuntime(decision, resolve, async () => {
      if (input.runtimePinned && input.runtime?.modelId) {
        if (!modelSupported(input.runtime.modelId)) throw new Error(`Unsupported model: ${input.runtime.modelId}`);
        return { ...input.runtime, modelId: input.runtime.modelId };
      }
      return resolve(input.runtime);
    });
    if (routed.routedBy) routedBy(routed.routedBy);
    return routed.choice;
  });
  if (config.securityScreenProxy) {
    delete harness.models.screenSecurity;
  }
  every("run-signals:prune", 60 * 60_000, () => runSignals.prune(7 * 24 * 60 * 60_000));
  return {
    harness,
    runSignals,
    fallback,
    hydrateModelCatalog,
    orgBaseModelId,
    judgeModelId,
    modelCredentials,
    gatewayTransport,
    directProviderAvailability,
    resolveMemoryEmbedder,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    resolveBrowserCompanyKeys,
  };
}

export type HarnessModule = ReturnType<typeof buildHarness>;

function buildModelCredentials(deps: HarnessInputs) {
  const { config, overrides, connectorSecretKey } = deps;
  const { databaseUrl } = deps.stores;

  const unknownGatewayModels = Object.keys(config.modelGateway?.models ?? {}).filter((id) => !resolveModel(id));
  if (unknownGatewayModels.length) {
    throw new Error(`MODEL_GATEWAY_MODELS contains unsupported models: ${unknownGatewayModels.join(", ")}`);
  }
  const gatewayCatalog = config.modelGateway
    ? createGatewayCatalog(config.modelGateway, overrides.modelCredentialFetch)
    : undefined;
  const gatewayTransport =
    gatewayCatalog &&
    Object.defineProperty(gatewayCatalog.transport, "apiKey", {
      enumerable: true,
      get: () => tenantConfig(config).modelGatewayApiKey ?? config.modelGateway!.apiKey,
    });
  const directProviderAvailability = providerKeysPresent(config);
  const directModelCredentials = createModelCredentialStore({
    databaseUrl,
    keyMaterial: () => tenantConfig(config).connectorSecretKey ?? connectorSecretKey,
    fallback: {
      ...(config.anthropicApiKey ? { anthropic: config.anthropicApiKey } : {}),
      ...(config.openaiApiKey ? { openai: config.openaiApiKey } : {}),
      ...(config.openrouterApiKey ? { openrouter: config.openrouterApiKey } : {}),
    },
  });
  const modelCredentials: ModelCredentialStore = {
    ...directModelCredentials,
    async availability() {
      await gatewayCatalog?.refresh();
      const direct = await directModelCredentials.availability();
      return {
        ...direct,
        ...(directProviderAvailability.codexOAuth ? { codexOAuth: true } : {}),
        ...(config.claudeAuthCredential ? { anthropic: true } : {}),
        modelIds: new Set(Object.keys(gatewayTransport?.models ?? {})),
      };
    },
  };
  return { gatewayCatalog, modelCredentials, gatewayTransport, directProviderAvailability };
}

function buildModelKeys(deps: HarnessInputs, mc: ReturnType<typeof buildModelCredentials>) {
  const { advisoryLock, databaseUrl } = deps.stores;
  const { connectorSecretKey, overrides, config } = deps;
  const { keychain } = deps.credentials;
  const { gatewayCatalog, modelCredentials, gatewayTransport } = mc;

  const writeModelRegistry = <T>(fn: () => Promise<T>): Promise<T> =>
    advisoryLock.withLock("model-registry", async () => {
      await refreshModels();
      return fn();
    });
  const customProviders = createCustomProviderStore({
    write: writeModelRegistry,
    databaseUrl,
    keyMaterial: () => tenantConfig(config).connectorSecretKey ?? connectorSecretKey,
  });
  const refreshCustomProviders = async () => {
    setCustomProviders(await customProviders.enabled());
  };
  const refreshModels = async () => {
    await gatewayCatalog?.refresh();
    await refreshCustomProviders();
  };
  const resolveMemoryEmbedder = async (id: string): Promise<MemoryEmbedder> => {
    const model = resolveEmbeddingModel(id);
    if (!model) throw new Error(`Embedding model unavailable: ${id}`);
    const key = model.provider === "openai" ? await modelCredentials.resolve("openai") : null;
    return createMemoryEmbedder(model, key, gatewayTransport, overrides.modelCredentialFetch);
  };
  const resolveModelProviderKeys = async () => {
    await refreshModels();
    const [anthropic, openai, openrouter, enabledCustom] = await Promise.all([
      modelCredentials.resolve("anthropic"),
      modelCredentials.resolve("openai"),
      modelCredentials.resolve("openrouter"),
      customProviders.enabled(),
    ]);
    const customKeys = Object.fromEntries(
      (
        await Promise.all(
          enabledCustom.map(async (p) => {
            try {
              return [p.id, await customProviders.resolveKey(p.id)] as const;
            } catch (e) {
              reportFailure("model: custom provider key unreadable", e, p.id);
              return [p.id, null] as const;
            }
          }),
        )
      ).filter(([, key]) => key),
    );
    return {
      ...(anthropic ? { anthropic } : {}),
      ...(openai ? { openai } : {}),
      ...(openrouter ? { openrouter } : {}),
      ...customKeys,
    };
  };
  const companyChatGPTAuth: CompanyChatGPTAuth | undefined = config.codexAuthCredential
    ? keychainCompanyChatGPTAuth({ keychain, credentialId: config.codexAuthCredential })
    : undefined;
  const resolveCompanySubscriptionKeys = async (): Promise<ProviderKeys> => {
    if (!companyChatGPTAuth) return {};
    try {
      const token = await companyChatGPTAuth.accessToken();
      return token ? { [CODEX_SUBSCRIPTION_PROVIDER]: token } : {};
    } catch (e) {
      reportFailure("model: company ChatGPT auth unreadable", e, companyChatGPTAuth.description);
      return {};
    }
  };
  const companyClaudeAuthEnv = config.claudeAuthCredential
    ? keychainHarnessAuthEnv(keychain, config.claudeAuthCredential, ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    : undefined;
  const resolveCompanyClaudeKeys = async (): Promise<ProviderKeys> => {
    if (!companyClaudeAuthEnv) return {};
    const env = await companyClaudeAuthEnv();
    const token = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
    if (!token)
      console.error(
        `[model] company Claude subscription credential ${config.claudeAuthCredential} yielded no token (missing, expired, or not an env credential)`,
      );
    return token ? { anthropic: token } : {};
  };
  const resolvePiProviderKeys = async (): Promise<ProviderKeys> => ({
    ...(await resolveCompanyClaudeKeys()),
    ...(await resolveModelProviderKeys()),
    ...(await resolveCompanySubscriptionKeys()),
  });
  const resolveBrowserCompanyKeys = async (includeSubscription = true): Promise<ProviderKeys> =>
    includeSubscription ? resolvePiProviderKeys() : resolveModelProviderKeys();
  return {
    resolveMemoryEmbedder,
    resolvePiProviderKeys,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    resolveBrowserCompanyKeys,
  };
}
