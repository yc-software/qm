import { isBackendCredential } from "../../credentials/keychain.ts";
import { personalScope } from "../../types.ts";
import { connectorTokenNote } from "../../credentials/connector-token.ts";
import {
  credentialHandle,
  type PublicServiceCredential,
  type KeychainManifestInput,
} from "../../credentials/keychain.ts";
import { PROVIDERS } from "../../connectors/oauth.ts";
import { mintCapabilityToken, CREDENTIAL_BROKER_AUD, type BrokeredConnector } from "../../auth/capability-token.ts";
import { type CommandCredential } from "../../tools/primitives.ts";
import { principalEntitledToScope } from "../../resolution/context-filter.ts";
import { parseRef } from "../../acl/resource-ref.ts";
import type { TurnCtx } from "./turn-context.ts";

const CREDENTIAL_TOKEN_ENV = "AGENT_CREDENTIAL_TOKEN";
const AWS_BROKER_ENV = {
  AWS_ACCESS_KEY_ID: "accessKeyId",
  AWS_SECRET_ACCESS_KEY: "secretAccessKey",
  AWS_SESSION_TOKEN: "sessionToken",
  AWS_REGION: "region",
  AWS_DEFAULT_REGION: "region",
} as const;
const CONNECTOR_HOSTS = Object.values(PROVIDERS).flatMap((p) => p.hosts);

export function createCatalogState(
  ctx: TurnCtx,
  strictReadOnly: boolean,
  openSpeakerKeychain: boolean,
  openAutomationKeychain: boolean,
  sharedScope: boolean,
) {
  const { deps, input, actor, conversation, external, liveTurn, resolution, scopeId } = ctx;
  return {
    ...ctx,
    strictReadOnly,
    openSpeakerKeychain,
    openAutomationKeychain,
    ownCredentialsAllowed: scopeId === personalScope(actor.id) || openSpeakerKeychain || openAutomationKeychain,
    sharedScope,
    brokerAvailable: Boolean(deps.signingSecret && deps.apiBaseUrl),
    orgWideAudience:
      conversation.audience.length > 0 &&
      conversation.audience.every((p) =>
        principalEntitledToScope(p, resolution.orgScopeId, scopeId, resolution.orgScopeId),
      ),
    scopeAttestation: {
      ...(external ? { externalSlack: true as const } : {}),
      actorId: actor.id,
      scopeId,
      ...(input.scopeVersion ? { scopeVersion: input.scopeVersion } : {}),
      ...(conversation.publishMembers ? { members: conversation.publishMembers } : {}),
      ...(liveTurn ? { liveActor: true } : {}),
      ...(input.botActor ? { botActor: true } : {}),
    },
    sandboxTokenExpiry: 0,
    connectorEnv: {} as Record<string, string>,
    commandCredentials: [] as CommandCredential[],
    credentialDescriptions: [] as NonNullable<KeychainManifestInput["execution"]>,
    credentialIdentities: new Map<string, string>(),
  };
}

export type CatalogState = ReturnType<typeof createCatalogState>;
type CredentialBroker = ReturnType<typeof credentialBroker>;
type AddCredential = (
  credential: CommandCredential,
  description: string,
  identity?: string,
  ownerId?: string,
  credentialId?: string,
) => void;

async function authorizeOwnerCredentials(c: CatalogState): Promise<void> {
  const { openSpeakerKeychain, openAutomationKeychain, isCurrentSharedScopeMember, actor, scopeId } = c;
  if (!openSpeakerKeychain && !openAutomationKeychain) return;
  if (!(await isCurrentSharedScopeMember(actor.id, scopeId))) {
    throw new Error("Open speaker keychain access is no longer authorized");
  }
  c.deps.auditLog.record({
    at: Date.now(),
    principalId: actor.id,
    action: "keychain.open_speaker_use",
    resource: "scratch execution",
    scopeLabel: scopeId,
  });
}

/** In a shared scope, a credential that is not a brokered org service runs only on the turn's scratch computer. */
export function placeCredential(
  c: Pick<CatalogState, "sharedScope">,
  credential: CommandCredential,
): CommandCredential {
  return { ...credential, scratchOnly: c.sharedScope && credential.scratchOnly !== false };
}

export function credentialBroker(c: CatalogState, requested: readonly string[]) {
  const { deps } = c;
  const credentials: string[] = [];
  const connectors: BrokeredConnector[] = [];
  let token: Promise<string> | undefined;
  return {
    service: (slug: string) => {
      if (requested.includes(slug) && !credentials.includes(slug)) credentials.push(slug);
    },
    connector: (connector: BrokeredConnector) => {
      if (requested.includes(connector.handle) && !connectors.some((c) => c.handle === connector.handle))
        connectors.push(connector);
    },
    env: async () => [
      { key: "AGENT_API_URL", value: deps.apiBaseUrl!, secret: false },
      {
        key: CREDENTIAL_TOKEN_ENV,
        value: await (token ??= mintBrokerToken(c, credentials.toSorted(), connectors)),
      },
    ],
  };
}

const connectorOf = (
  credential: import("../../credentials/keychain.ts").KeychainCredentialMeta,
  grantId?: string,
): BrokeredConnector | undefined =>
  credential.managed === "connector" && credential.host
    ? {
        handle: credentialHandle(credential),
        host: credential.host,
        ownerId: credential.ownerId,
        ...(credential.refresh?.accountType ? { accountType: credential.refresh.accountType } : {}),
        ...(grantId ? { grantId } : {}),
      }
    : undefined;

async function resolvedCredential(
  c: CatalogState,
  materialized: import("../../credentials/keychain.ts").MaterializedCred,
  broker: CredentialBroker,
) {
  const { deps } = c;
  if (materialized.kind === "connector") return { env: await broker.env() };
  if (materialized.kind === "env") return { env: materialized.env };
  return {
    env: [],
    files: {
      files: materialized.files,
      save: (files: import("../../credentials/keychain.ts").CredentialFile[]) =>
        deps.keychain!.updateFiles(materialized, files),
      source: {
        credentialId: materialized.credentialId,
        ownerId: materialized.ownerId,
        service: materialized.service,
        ...(materialized.grantId ? { grantId: materialized.grantId } : {}),
      },
    },
  };
}

export function addCredentialToCatalog(
  c: CatalogState,
  credential: CommandCredential,
  description: string,
  identity = credential.handle,
  ownerId = c.actor.id,
  credentialId?: string,
): void {
  const { credentialIdentities, commandCredentials, credentialDescriptions } = c;
  const existing = credentialIdentities.get(credential.handle);
  if (existing !== undefined) {
    if (existing !== identity) throw new Error(`credential handle collision: ${credential.handle}`);
    return;
  }
  credentialIdentities.set(credential.handle, identity);
  commandCredentials.push(placeCredential(c, credential));
  credentialDescriptions.push({ handle: credential.handle, ownerId, description, credentialId });
}

export async function registerKeychainCredentials(
  c: CatalogState,
  addCredential: AddCredential,
  broker: CredentialBroker,
): Promise<void> {
  const { deps, actor, scopeId, external, strictReadOnly, brokerAvailable, ownCredentialsAllowed } = c;
  if (external || strictReadOnly || !deps.keychain) return;
  const keychain = deps.keychain;
  for (const { grant, credential } of await keychain.grantsForScope(scopeId)) {
    if (credential.kind === "broker" || isBackendCredential(credential)) continue;
    const connector = connectorOf(credential, grant.id);
    if (connector && !brokerAvailable) continue;
    if (connector) broker.connector(connector);
    addCredential(
      {
        handle: credentialHandle(credential),
        resolve: async () => {
          const prepared = await keychain.prepareMaterialize(grant.id, scopeId, actor.id);
          return {
            ...(await resolvedCredential(c, prepared.materialized, broker)),
            commit: prepared.commit,
            singleUse: prepared.singleUse,
          };
        },
      },
      `${credential.service}, owner ${credential.ownerId}, grant ${grant.id}${connector ? `; ${connectorTokenNote(connector.host)}` : ""}`,
      credential.id,
      credential.ownerId,
      credential.id,
    );
  }
  if (ownCredentialsAllowed) {
    for (const credential of await keychain.listByOwner(actor.id)) {
      if (credential.kind === "broker" || isBackendCredential(credential)) continue;
      const connector = connectorOf(credential);
      if (connector && !brokerAvailable) continue;
      if (connector) broker.connector(connector);
      addCredential(
        {
          handle: credentialHandle(credential),
          resolve: async () => {
            await authorizeOwnerCredentials(c);
            return resolvedCredential(
              c,
              await keychain.materializeOwnById(actor.id, credential.id, personalScope(actor.id)),
              broker,
            );
          },
        },
        `${credential.service}, owner ${credential.ownerId}${connector ? `; ${connectorTokenNote(connector.host)}` : ""}`,
        credential.id,
        credential.ownerId,
        credential.id,
      );
    }
  }
}

export async function registerConnectorCredentials(
  c: CatalogState,
  addCredential: AddCredential,
  broker: CredentialBroker,
): Promise<void> {
  const { deps, actor, external, strictReadOnly, brokerAvailable, ownCredentialsAllowed } = c;
  if (!external && !strictReadOnly && brokerAvailable && deps.connectorTokens && ownCredentialsAllowed) {
    const tokens = deps.connectorTokens;
    const inventory = tokens.listConnectorsByOwners
      ? ((await tokens.listConnectorsByOwners([actor.id])).get(actor.id) ?? [])
      : undefined;
    for (const host of CONNECTOR_HOSTS) {
      for (const accountType of ["personal", undefined, "company"]) {
        const status = inventory
          ? inventory.find(
              (credential) =>
                credential.host === host && (credential.accountType ?? "default") === (accountType ?? "default"),
            )
          : await tokens.connectorTokenStatus(host, actor.id, accountType);
        if (!status?.connected || status.needsReconnect) continue;
        const handle = `connector:${host}:${accountType ?? "default"}`;
        broker.connector({ handle, host, ownerId: actor.id, ...(accountType ? { accountType } : {}) });
        addCredential(
          {
            handle,
            resolve: async () => {
              await authorizeOwnerCredentials(c);
              if (!(await tokens.connectorAccessToken(host, actor.id, accountType)))
                throw new Error(`Connector is no longer available: ${host}`);
              return { env: await broker.env() };
            },
          },
          `${host} connector, account ${accountType ?? "default"}; ${connectorTokenNote(host)}`,
          "credentialId" in status ? status.credentialId : undefined,
          actor.id,
          "credentialId" in status ? status.credentialId : undefined,
        );
      }
    }
  }
}

async function aclGrantedServiceCredSlugs(c: CatalogState): Promise<Set<string>> {
  const { deps, conversation, scopeId, resolution } = c;
  return new Set(
    (
      await deps.acl.grantsOfKind(
        "service-cred",
        conversation.audience,
        scopeId,
        resolution.orgScopeId,
        principalEntitledToScope,
      )
    ).map((g) => parseRef(g.ref).id),
  );
}

export async function grantedServiceCredSlugs(
  c: CatalogState,
  records: readonly PublicServiceCredential[],
): Promise<Set<string>> {
  const granted = await aclGrantedServiceCredSlugs(c);
  if (c.orgWideAudience) for (const record of records) if (record.source === "deployment") granted.add(record.slug);
  return granted;
}

async function authorizeServiceCredential(c: CatalogState, slug: string): Promise<void> {
  const { deps, serviceAllowed, orgWideAudience, resolution } = c;
  if (!serviceAllowed(slug)) throw new Error("Service is not approved for external Slack.");
  if ((await aclGrantedServiceCredSlugs(c)).has(slug)) return;
  const supplied =
    orgWideAudience &&
    ((await deps.serviceCreds?.listServiceCredentials(resolution.orgScopeId)) ?? []).some(
      (record) => record.slug === slug && record.source === "deployment",
    );
  if (!supplied) {
    throw new Error(`Service credential is no longer authorized: ${slug}`);
  }
}

function mintBrokerToken(c: CatalogState, credentials: string[], connectors: BrokeredConnector[]): Promise<string> {
  const { deps, input, conversation, external, scopeAttestation, sandboxTokenExpiry } = c;
  return mintCapabilityToken(
    {
      ...scopeAttestation,
      aud: CREDENTIAL_BROKER_AUD,
      ...(external
        ? {
            runId: input.runId,
            runAttempt: input.attempt,
            runLeaseToken: input.runLeaseToken,
            threadRef: conversation.threadRef,
          }
        : {}),
      credentials,
      ...(connectors.length ? { connectors } : {}),
      exp: sandboxTokenExpiry,
    },
    (deps.capabilitySecret ?? deps.signingSecret)!,
    deps.capabilityTokenCompression,
  );
}

export async function registerServiceCredentials(
  c: CatalogState,
  addCredential: AddCredential,
  broker: CredentialBroker,
): Promise<void> {
  const { deps, strictReadOnly, resolution, serviceAllowed, allInternal, external, brokerAvailable } = c;
  if (strictReadOnly || !deps.serviceCreds) return;
  const records = (await deps.serviceCreds.listServiceCredentials(resolution.orgScopeId)).filter((record) =>
    serviceAllowed(record.slug),
  );
  const granted = await grantedServiceCredSlugs(c, records);
  const available = records.filter(
    (record) => !isBackendCredential(record) && record.enabled && record.hasSecret && granted.has(record.slug),
  );
  for (const credential of available) {
    if (credential.delivery === "env") {
      if ((!allInternal && !external) || !credential.envKey) continue;
      addCredential(
        {
          handle: credential.slug,
          resolve: async () => {
            await authorizeServiceCredential(c, credential.slug);
            const current = await deps.serviceCreds!.getServiceCredentialSecret(resolution.orgScopeId, credential.slug);
            if (
              !current?.enabled ||
              isBackendCredential(current) ||
              !current.secret ||
              current.delivery !== "env" ||
              current.envKey !== credential.envKey
            ) {
              throw new Error(`Service credential is no longer available: ${credential.slug}`);
            }
            return { env: [{ key: credential.envKey!, value: current.secret }] };
          },
        },
        `${credential.name}; provides ${credential.envKey}`,
        undefined,
        "Organization",
      );
    } else if (brokerAvailable) {
      broker.service(credential.slug);
      addCredential(
        {
          handle: credential.slug,
          scratchOnly: false,
          resolve: async () => {
            await authorizeServiceCredential(c, credential.slug);
            const record = (await deps.serviceCreds!.listServiceCredentials(resolution.orgScopeId)).find(
              (candidate) => candidate.slug === credential.slug,
            );
            if (!record?.enabled || !record.hasSecret || record.delivery === "env") {
              throw new Error(`Service credential is no longer available: ${credential.slug}`);
            }
            return { env: await broker.env() };
          },
        },
        `${credential.name}; proxy ${credential.host}; ${(credential.allowedMethods?.length ? credential.allowedMethods : ["GET"]).toSorted().join("/")}; ${credential.allowedPathPrefixes?.length ? `paths ${credential.allowedPathPrefixes.toSorted().join(", ")}` : "any path"}; use the use-shared-credential skill`,
        undefined,
        "Organization",
      );
    }
  }
}

export function registerBrokeredTools(c: CatalogState, addCredential: AddCredential): void {
  const { deps, actor, scopeId, external, strictReadOnly } = c;
  const brokeredTools = external ? [] : (deps.brokeredTools ?? []);
  if (!strictReadOnly && actor.type === "internal") {
    for (const tool of brokeredTools) {
      const broker = deps.layerBrokerFor?.(tool);
      if (!broker) continue;
      addCredential(
        {
          handle: `broker_${tool.service}`,
          resolve: async () => {
            let aws;
            try {
              aws = await broker.credsForActor(actor.id);
            } catch (e) {
              deps.credentialUsage?.record({
                slug: tool.service,
                host: "sts.amazonaws.com",
                status: "unavailable",
                scopeLabel: scopeId,
                principalId: actor.id,
              });
              throw new Error(`Could not vend credentials for ${tool.service}`, { cause: e });
            }
            deps.credentialUsage?.record({
              slug: tool.service,
              host: "sts.amazonaws.com",
              status: "vended",
              scopeLabel: scopeId,
              principalId: actor.id,
            });
            return {
              env: Object.entries(AWS_BROKER_ENV).map(([key, field]) => ({
                key,
                value: aws[field],
                secret: field !== "region",
              })),
            };
          },
        },
        `${tool.service}, role broker for ${actor.id}`,
      );
    }
  }
}
