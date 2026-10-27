import type { StoresModule } from "./stores.ts";
import type { FilesModule } from "./files.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { Head } from "./late.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";
import { perTenant } from "../tenant.ts";
import { tenantSecretKey } from "../credentials/tenant-secret-key.ts";
import { createEnvSecretSource } from "../credentials/secret-source.ts";
import { type OAuthClientResolver, withPublicOAuthClients, makeRefresh } from "../connectors/oauth.ts";
import { createConnectorClientResolver, deriveConnectorKey } from "../connectors/connector-client-store.ts";
import { scopeId } from "../types.ts";
import type { Keychain, OAuthToken } from "../credentials/keychain.ts";
import { createKeychain } from "../credentials/create-keychain.ts";
import { createKeychainStore } from "../credentials/keychain-store.ts";
import { refreshChatGPTTokens, refreshClaudeTokens } from "../model/subscription-oauth.ts";
import { createUserModelCredentialStore } from "../model/user-model-credential-store.ts";
import { withDeploymentCredentials } from "../credentials/deployment-credentials.ts";
import type { Config } from "../config.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";
import { createMcpToolService } from "../mcp/mcp-tool-service.ts";
import { type BrowserSessionStore, createBrowserSessionStore } from "../connectors/browser-session-store.ts";
import { type ConsentLinkStore, createConsentLinkStore } from "../connectors/consent-link.ts";
import { type OAuthFlowStore, createOAuthFlowStore } from "../connectors/oauth-flow-store.ts";
import { type SecretDropStore, createSecretDropStore } from "../credentials/secret-drop.ts";
import { createModelGateway } from "../model/model-gateway.ts";

type CredentialsInputs = Pick<Head, "overrides" | "config" | "connectorSecretKey"> & {
  stores: StoresModule;
  files: FilesModule;
  deploymentLayer: DeploymentLayerModule;
};

export function buildCredentials(deps: CredentialsInputs) {
  const { overrides, config, connectorSecretKey } = deps;
  const { configStore, databaseUrl, advisoryLock, identity } = deps.stores;
  const { mcpServers } = deps.files;
  const { auditLog, deploymentLayerStore, installCatalogs } = deps.deploymentLayer;

  const secretSource = createEnvSecretSource(overrides.env);
  const resolveClient: OAuthClientResolver = withPublicOAuthClients(
    createConnectorClientResolver({
      reader: configStore,
      orgScopeId: (o) => scopeId("org", o),
      secrets: secretSource,
    }),
  );
  const credentialKey = tenantSecretKey(() => {
    const { signingSecret, connectorSecretKey: tenantKey = connectorSecretKey } = tenantConfig(config);
    const signingSecretCredentialKey =
      signingSecret && signingSecret !== tenantKey ? deriveConnectorKey(signingSecret, "keychain") : undefined;
    return {
      ...deriveConnectorKey(tenantKey, "keychain"),
      ...(signingSecretCredentialKey ? { fallbacks: [signingSecretCredentialKey] } : {}),
    };
  });
  const credentialStore: Keychain = createKeychain({
    store: createKeychainStore(databaseUrl),
    key: credentialKey,
    lock: advisoryLock,
    refreshConnector: (() => {
      const base = makeRefresh({ resolveClient });
      return async (host: string, token: OAuthToken, ctx?: { accountType?: string; clientRef?: string }) => {
        if (token.refreshToken && host === "auth.openai.com") {
          const fresh = await refreshChatGPTTokens(token.refreshToken);
          return oauthTokenFromUserTokens(fresh);
        }
        if (token.refreshToken && host === "claude.ai") {
          const fresh = await refreshClaudeTokens(token.refreshToken);
          return oauthTokenFromUserTokens(fresh);
        }
        return base(host, token, ctx);
      };
    })(),
  });
  const oauthTokenFromUserTokens = (fresh: {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    accountId?: string;
    expiresAt?: number;
  }): OAuthToken => ({
    accessToken: fresh.accessToken,
    ...(fresh.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
    ...(fresh.idToken ? { idToken: fresh.idToken } : {}),
    ...(fresh.accountId ? { accountId: fresh.accountId } : {}),
    ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
  });
  const userModelCredentials = createUserModelCredentialStore({ keychain: credentialStore });
  const keychain: Keychain = credentialStore;
  const serviceCreds = withDeploymentCredentials(
    credentialStore,
    scopeId("org", config.orgId),
    config.brokerCredentials ?? [],
  );
  const warnShadowedBrokerCredentials = (brokerCredentials: NonNullable<Config["brokerCredentials"]>) => {
    const reserved = new Set(brokerCredentials.map((c) => c.slug));
    void credentialStore.listServiceCredentials(scopeId("org", config.orgId)).then(
      (stored) => {
        const shadowed = stored.filter((c) => reserved.has(c.slug)).map((c) => c.slug);
        if (shadowed.length)
          console.warn(`[broker-credentials] BROKER_CREDENTIALS overrides stored credentials: ${shadowed.join(", ")}`);
      },
      (error) =>
        console.warn(`[broker-credentials] could not check for overridden stored credentials: ${errMessage(error)}`),
    );
  };
  const mcpToolService = createMcpToolService({
    servers: mcpServers,
    audit: auditLog,
    userTokens: keychain,
    signInUrl: (id: string) => {
      const base = tenantConfig(config).publicWebUrl;
      return base ? `${base}/connect/${encodeURIComponent(id)}/self-connect` : undefined;
    },
  });
  const browserSessionStore: BrowserSessionStore = createBrowserSessionStore({
    databaseUrl,
    key: credentialKey,
  });
  const connectorTokens = credentialStore;
  const consentLinks: ConsentLinkStore = createConsentLinkStore(databaseUrl);
  const oauthFlows: OAuthFlowStore = createOAuthFlowStore(databaseUrl);
  const secretDrops: SecretDropStore = createSecretDropStore(databaseUrl);
  const modelGateway = createModelGateway();
  const started = perTenant(() => ({
    at: undefined as { ready: Promise<void>; skillsReady: Promise<void> } | undefined,
  }));
  const startOnce = () => {
    const tenantStart = started();
    if (tenantStart.at) return tenantStart.at;
    const layerReady = deploymentLayerStore.hydrate();
    const layerSettled = layerReady.then(() => undefined, reportFailureAs("startup: deployment layer", undefined));
    const skillsReady = config.seedSkills
      ? Promise.all([
          installCatalogs().catch(reportFailureAs("startup: install seed skills", undefined)),
          layerSettled,
        ]).then(() => undefined)
      : layerSettled;
    const { brokerCredentials } = tenantConfig(config);
    if (brokerCredentials?.length) warnShadowedBrokerCredentials(brokerCredentials);
    const identityReady = identity.hydrate();
    const configReady = configStore.hydrate?.();
    identityReady.catch(reportFailureAs("startup: hydrate identity", undefined));
    configReady?.catch(reportFailureAs("startup: hydrate configuration", undefined));
    const ready = Promise.all([identityReady, configReady, layerReady]).then(() => {});
    const at = { ready, skillsReady };
    ready.catch(() => {
      if (tenantStart.at === at) tenantStart.at = undefined;
    });
    tenantStart.at = at;
    return at;
  };
  const skillsReady: PromiseLike<void> = { then: (resolve, reject) => startOnce().skillsReady.then(resolve, reject) };
  return {
    keychain,
    serviceCreds,
    userModelCredentials,
    connectorTokens,
    modelGateway,
    mcpToolService,
    resolveClient,
    consentLinks,
    oauthFlows,
    secretDrops,
    browserSessionStore,
    skillsReady,
    startOnce,
  };
}

export type CredentialsModule = ReturnType<typeof buildCredentials>;
