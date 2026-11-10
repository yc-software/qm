import type { AuditEvent } from "../../audit/audit-log.ts";
import { CREDENTIAL_BROKER_AUD, mintCapabilityToken, type CapabilityClaims } from "../../auth/capability-token.ts";
import { CONNECTOR_HOSTS } from "../../connectors/oauth.ts";
import { envKey } from "../../credentials/connector-token.ts";
import {
  connectorHandle,
  connectorLine,
  credentialHandle,
  credentialLineText,
  isBackendCredential,
  type KeychainManifestInput,
  type CredentialFile,
  type Keychain,
  type MaterializedCred,
  type PublicServiceCredential,
} from "../../credentials/keychain.ts";
import { parseRef } from "../../acl/resource-ref.ts";
import { samePerson } from "../../directory/person.ts";
import { entitledScopes, principalEntitledToScope } from "../../resolution/context-filter.ts";
import { isOpenScopeMember } from "../../resolution/sharing-access.ts";
import type { IsCurrentSharedScopeMember } from "../../resolution/scope-membership.ts";
import type { CommandCredential } from "../../tools/primitives.ts";
import { personalScope, type ScopeId } from "../../types.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";
import type { Tenant } from "../../tenants/context.ts";

export interface CredentialCatalogTurn {
  tenant: Tenant;
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  conversation: OrchestratorInput["conversation"];
  external: boolean;
  strictReadOnly: boolean;
  allInternal: boolean;
  liveAuthorTurn: boolean;
  scopeId: ScopeId;
  environmentId: string;
  sharingSources: readonly ScopeId[];
  resolution: Awaited<ReturnType<OrchestratorDeps["resolution"]["resolve"]>>;
  isCurrentSharedScopeMember: IsCurrentSharedScopeMember;
  audit: (event: Omit<AuditEvent, "at" | "principalId" | "scopeLabel">) => void;
  scopeKeychainGrants: () => Promise<
    Array<Awaited<ReturnType<Keychain["grantsForScope"]>>[number] & { grantScope: ScopeId }>
  >;
  serviceAllowed: (slug: string) => boolean;
  aclGrantedServiceCredSlugs: () => Promise<Set<string>>;
  grantedServiceCredSlugs: (records: readonly PublicServiceCredential[]) => Promise<Set<string>>;
  orgWideAudience: boolean;
}

export type CredentialCatalog = Awaited<ReturnType<typeof createCredentialCatalog>>;
export type AddCredential = CredentialCatalog["addCredentialToCatalog"];

export async function createCredentialCatalog(turn: CredentialCatalogTurn) {
  const {
    deps,
    input,
    actor,
    conversation,
    external,
    liveAuthorTurn,
    scopeId,
    environmentId,
    sharingSources,
    resolution,
    isCurrentSharedScopeMember,
    audit,
    serviceAllowed,
    aclGrantedServiceCredSlugs,
    orgWideAudience,
  } = turn;
  const brokeredTools = external ? [] : (deps.brokeredTools ?? []);
  const openSpeakerKeychain =
    liveAuthorTurn && conversation.kind !== "dm" && sharingSources.includes(personalScope(actor.id));
  const openAutomationKeychain =
    !external &&
    input.origin.kind === "automation" &&
    input.origin.useOwnerKeychain === true &&
    conversation.kind !== "dm" &&
    !!deps.isCurrentSharedScopeMember &&
    (await isOpenScopeMember({
      actorId: actor.id,
      scope: scopeId,
      config: deps.config,
      isCurrentSharedScopeMember: deps.isCurrentSharedScopeMember,
    }));
  const ownCredentialsAllowed = scopeId === personalScope(actor.id) || openSpeakerKeychain || openAutomationKeychain;
  const sharedScope =
    !external &&
    (scopeId !== personalScope(actor.id) ||
      environmentId !== scopeId ||
      ((await deps.environments?.attachmentsFor(environmentId)) ?? []).some(
        (attachment) => attachment.scopeId !== scopeId,
      ));
  const connectorEnv: Record<string, string> = {};
  const commandCredentials: CommandCredential[] = [];
  const credentialDescriptions: NonNullable<KeychainManifestInput["execution"]> = [];
  const credentialIdentities = new Map<string, string>();

  const authorizeOwnerCredentials = async (): Promise<void> => {
    if (!openSpeakerKeychain && !openAutomationKeychain) return;
    if (
      !(await isCurrentSharedScopeMember(actor.id, scopeId)) ||
      (await deps.config.resolveSharingPostureDurable(personalScope(actor.id), scopeId)) !== "open"
    ) {
      throw new Error("Open speaker keychain access is no longer authorized");
    }
    audit({
      action: "keychain.open_speaker_use",
      resource: "scratch execution",
    });
  };
  const resolvedCredential = (materialized: MaterializedCred, writeback: boolean) => {
    if (materialized.kind === "env") return { env: materialized.env };
    return {
      env: [],
      files: {
        files: materialized.files,
        save: (files: CredentialFile[]) => deps.keychain!.updateFiles({ ...materialized, writeback }, files),
        source: {
          credentialId: materialized.credentialId,
          ownerId: materialized.ownerId,
          service: materialized.service,
          ...(materialized.grantId ? { grantId: materialized.grantId } : {}),
          writeback,
        },
      },
    };
  };
  const placeCredential = (credential: CommandCredential): CommandCredential => ({
    ...credential,
    scratchOnly: sharedScope && credential.scratchOnly !== false,
  });
  const addCredentialToCatalog = (
    credential: CommandCredential,
    description: string,
    identity = credential.handle,
    ownerId = actor.id,
    credentialId?: string,
  ): void => {
    const existing = credentialIdentities.get(credential.handle);
    if (existing !== undefined) {
      if (existing !== identity) throw new Error(`credential handle collision: ${credential.handle}`);
      return;
    }
    credentialIdentities.set(credential.handle, identity);
    commandCredentials.push(placeCredential(credential));
    credentialDescriptions.push({ handle: credential.handle, ownerId, description, credentialId });
  };
  const authorizeServiceCredential = async (slug: string): Promise<void> => {
    if (!serviceAllowed(slug)) throw new Error("Service is not approved for external Slack.");
    if ((await aclGrantedServiceCredSlugs()).has(slug)) return;
    const supplied =
      orgWideAudience &&
      ((await deps.serviceCreds?.listServiceCredentials(resolution.orgScopeId)) ?? []).some(
        (record) => record.slug === slug && record.source === "deployment",
      );
    if (!supplied) {
      throw new Error(`Service credential is no longer authorized: ${slug}`);
    }
  };
  return {
    ...turn,
    brokeredTools,
    openSpeakerKeychain,
    openAutomationKeychain,
    ownCredentialsAllowed,
    connectorEnv,
    commandCredentials,
    credentialDescriptions,
    authorizeOwnerCredentials,
    resolvedCredential,
    placeCredential,
    addCredentialToCatalog,
    authorizeServiceCredential,
  };
}

export async function registerKeychainCredentials(
  catalog: CredentialCatalog,
  addCredential: AddCredential,
): Promise<void> {
  const {
    deps,
    actor,
    external,
    strictReadOnly,
    scopeKeychainGrants,
    ownCredentialsAllowed,
    authorizeOwnerCredentials,
    resolvedCredential,
  } = catalog;
  if (external || strictReadOnly || !deps.keychain) return;
  const keychain = deps.keychain;
  for (const { grant, credential, grantScope } of await scopeKeychainGrants()) {
    if (credential.kind === "broker" || isBackendCredential(credential)) continue;
    addCredential(
      {
        handle: credentialHandle(credential),
        resolve: async () => {
          const prepared = await keychain.prepareMaterialize(grant.id, grantScope, actor.id);
          return {
            ...resolvedCredential(prepared.materialized, samePerson(credential.ownerId, actor.id)),
            commit: prepared.commit,
            singleUse: prepared.singleUse,
          };
        },
      },
      credential.service,
      credential.id,
      credential.ownerId,
      credential.id,
    );
  }
  if (ownCredentialsAllowed) {
    for (const credential of await keychain.listByOwner(actor.id)) {
      if (credential.kind === "broker" || isBackendCredential(credential)) continue;
      addCredential(
        {
          handle: credentialHandle(credential),
          resolve: async () => {
            await authorizeOwnerCredentials();
            return resolvedCredential(
              await keychain.materializeOwnById(actor.id, credential.id, personalScope(actor.id)),
              true,
            );
          },
        },
        credential.service,
        credential.id,
        credential.ownerId,
        credential.id,
      );
    }
  }
}

export async function registerConnectorCredentials(
  catalog: CredentialCatalog,
  addCredential: AddCredential,
): Promise<void> {
  const { deps, actor, external, strictReadOnly, ownCredentialsAllowed, authorizeOwnerCredentials } = catalog;
  if (!external && !strictReadOnly && deps.connectorTokens && ownCredentialsAllowed) {
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
        const healthy = status?.connected && !status.needsReconnect;
        const operatorFallback =
          accountType === undefined &&
          tokens.operatorFallbackHosts?.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
        if (!healthy && !operatorFallback) continue;
        addCredential(
          {
            handle: connectorHandle(host, accountType),
            resolve: async () => {
              await authorizeOwnerCredentials();
              const token = await tokens.connectorAccessToken(host, actor.id, accountType);
              if (!token) throw new Error(`Connector is no longer available: ${host}`);
              return { env: [{ key: envKey(host), value: token }] };
            },
          },
          !healthy && operatorFallback
            ? `${host}, configured operator fallback${status?.refreshError ? ` (own connection's refresh failed: ${status.refreshError})` : ""}; availability checked on use; env \`${envKey(host)}\``
            : credentialLineText(connectorLine(host, accountType)),
          healthy && status && "credentialId" in status ? status.credentialId : undefined,
          actor.id,
          healthy && status && "credentialId" in status ? status.credentialId : undefined,
        );
      }
    }
  }
}

export async function registerServiceCredentials(
  catalog: CredentialCatalog,
  capability: { scopeAttestation: Omit<CapabilityClaims, "exp">; sandboxTokenExpiry: number },
  addCredential: AddCredential,
  requestedHandles: readonly string[],
  current?: { records: PublicServiceCredential[]; granted: Set<string> },
): Promise<void> {
  const {
    deps,
    input,
    conversation,
    external,
    strictReadOnly,
    allInternal,
    resolution,
    serviceAllowed,
    grantedServiceCredSlugs,
    authorizeServiceCredential,
  } = catalog;
  const { scopeAttestation, sandboxTokenExpiry } = capability;
  if (strictReadOnly || !deps.serviceCreds) return;
  const records =
    current?.records ??
    (await deps.serviceCreds.listServiceCredentials(resolution.orgScopeId)).filter((record) =>
      serviceAllowed(record.slug),
    );
  const granted = current?.granted ?? (await grantedServiceCredSlugs(records));
  const available = records.filter(
    (record) => !isBackendCredential(record) && record.enabled && record.hasSecret && granted.has(record.slug),
  );
  const brokerSlugs = available
    .filter((record) => record.delivery !== "env" && requestedHandles.includes(record.slug))
    .map((record) => record.slug)
    .sort();
  let brokerToken: Promise<string> | undefined;
  const resolveBrokerToken = (): Promise<string> =>
    (brokerToken ??= (async () => {
      const current = await deps.serviceCreds!.listServiceCredentials(resolution.orgScopeId);
      for (const slug of brokerSlugs) {
        await authorizeServiceCredential(slug);
        const record = current.find((candidate) => candidate.slug === slug);
        if (!record?.enabled || !record.hasSecret || record.delivery === "env") {
          throw new Error(`Service credential is no longer available: ${slug}`);
        }
      }
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
          credentials: brokerSlugs,
          exp: sandboxTokenExpiry,
        },
        (deps.capabilitySecret ?? deps.signingSecret)!,
        deps.capabilityTokenCompression,
      );
    })());
  for (const credential of available) {
    if (credential.delivery === "env") {
      if ((!allInternal && !external) || !credential.envKey) continue;
      addCredential(
        {
          handle: credential.slug,
          resolve: async () => {
            await authorizeServiceCredential(credential.slug);
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
        `${credential.name}; env \`${credential.envKey}\``,
        undefined,
        "Organization",
      );
    } else if (deps.signingSecret && deps.apiBaseUrl) {
      addCredential(
        {
          handle: credential.slug,
          scratchOnly: false,
          resolve: async () => ({ env: [{ key: "AGENT_CREDENTIAL_TOKEN", value: await resolveBrokerToken() }] }),
        },
        `${credential.name}; proxy ${credential.host}`,
        undefined,
        "Organization",
      );
    }
  }
}

export function registerBrokeredTools(catalog: CredentialCatalog): void {
  const { tenant, deps, actor, scopeId, strictReadOnly, brokeredTools, addCredentialToCatalog } = catalog;
  if (!strictReadOnly && actor.type === "internal") {
    for (const tool of brokeredTools) {
      const broker = deps.layerBrokerFor?.(tool);
      if (!broker) continue;
      addCredentialToCatalog(
        {
          handle: `broker_${tool.service}`,
          resolve: async () => {
            let aws;
            try {
              aws = await broker.credsForActor(actor.id);
            } catch {
              deps.credentialUsage?.record(tenant, {
                slug: tool.service,
                host: "sts.amazonaws.com",
                status: "unavailable",
                scopeLabel: scopeId,
                principalId: actor.id,
              });
              throw new Error(`Could not vend credentials for ${tool.service}`);
            }
            deps.credentialUsage?.record(tenant, {
              slug: tool.service,
              host: "sts.amazonaws.com",
              status: "vended",
              scopeLabel: scopeId,
              principalId: actor.id,
            });
            return {
              env: Object.entries({
                AWS_ACCESS_KEY_ID: aws.accessKeyId,
                AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
                AWS_SESSION_TOKEN: aws.sessionToken,
                AWS_REGION: aws.region,
                AWS_DEFAULT_REGION: aws.region,
              }).map(([key, value]) => ({
                key,
                value,
                secret: key !== "AWS_REGION" && key !== "AWS_DEFAULT_REGION",
              })),
            };
          },
        },
        `${tool.service}, role broker for ${actor.id}`,
      );
    }
  }
}

export async function loadServiceCredentialGrants(turn: {
  tenant: Tenant;
  deps: OrchestratorDeps;
  conversation: OrchestratorInput["conversation"];
  scopeId: ScopeId;
  resolution: CredentialCatalogTurn["resolution"];
  strictReadOnly: boolean;
  serviceAllowed: (slug: string) => boolean;
}) {
  const { tenant, deps, conversation, scopeId, resolution, strictReadOnly, serviceAllowed } = turn;
  const orgServiceCreds =
    !strictReadOnly && deps.serviceCreds ? await deps.serviceCreds.listServiceCredentials(resolution.orgScopeId) : [];
  const aclGrantedServiceCredSlugs = async (): Promise<Set<string>> =>
    new Set(
      (
        await deps.acl.grantsOfKind(
          tenant,
          "service-cred",
          conversation.audience,
          scopeId,
          resolution.orgScopeId,
          entitledScopes,
        )
      ).map((g) => parseRef(g.ref).id),
    );
  const orgWideAudience =
    conversation.audience.length > 0 &&
    conversation.audience.every((p) =>
      principalEntitledToScope(p, resolution.orgScopeId, scopeId, resolution.orgScopeId),
    );
  const grantedServiceCredSlugs = async (records: readonly PublicServiceCredential[]): Promise<Set<string>> => {
    const granted = await aclGrantedServiceCredSlugs();
    if (orgWideAudience) for (const record of records) if (record.source === "deployment") granted.add(record.slug);
    return granted;
  };
  const serviceCredRecords: PublicServiceCredential[] = orgServiceCreds.filter((record) => serviceAllowed(record.slug));
  let grantedCredSlugs = new Set<string>();
  if (serviceCredRecords.length > 0) grantedCredSlugs = await grantedServiceCredSlugs(serviceCredRecords);
  const appConnections = serviceCredRecords.some(
    (cred) => isBackendCredential(cred) && cred.enabled && cred.hasSecret && grantedCredSlugs.has(cred.slug),
  );
  return {
    aclGrantedServiceCredSlugs,
    orgWideAudience,
    grantedServiceCredSlugs,
    serviceCredRecords,
    grantedCredSlugs,
    appConnections,
  };
}
