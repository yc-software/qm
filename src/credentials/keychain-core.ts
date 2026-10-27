import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { type ScopeId } from "../types.ts";
import { encryptSecret, decryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
import { errMessage, reportFailure, reportFailureAs } from "../util/errors.ts";
import { canonicalPerson, personIds, personKey, samePerson } from "../directory/person.ts";
import { hashId } from "../util/crypto.ts";
import { homeRelativePath } from "./paths.ts";
import { tenant } from "../tenant.ts";
import type { KeychainStore } from "./keychain-store.ts";
import {
  type CreateGrantInput,
  type CredentialFile,
  credentialHandle,
  credentialInjectionError,
  type CredentialKind,
  fingerprintOf,
  isBackendCredential,
  isValidServiceCredentialEnvKey,
  type KeychainAsk,
  type KeychainCredential,
  type KeychainCredentialMeta,
  KeychainError,
  type KeychainGrant,
  type MaterializedCred,
  type MaterializedEnvCred,
  type MaterializedFileCred,
  MAX_CREDENTIAL_BYTES,
  MAX_CREDENTIAL_FILES,
  oauthExpired,
  type OAuthRefresh,
  type OAuthToken,
  type PublicServiceCredential,
  type SaveCredentialInput,
  type ServiceCredentialInput,
} from "./keychain.ts";

export interface KeychainDeps {
  store: KeychainStore;
  key: SecretKey;
  lock: AdvisoryLock;
  refreshConnector?: OAuthRefresh;
  oauthSkewMs?: number;
  oauthRefreshMarginMs?: number;
  now?: () => number;
}

export function keychainContext(deps: KeychainDeps) {
  const oauthSkew = deps.oauthSkewMs ?? 60_000;
  return {
    deps,
    store: deps.store,
    lock: deps.lock,
    now: deps.now ?? Date.now,
    oauthSkew,
    oauthRefreshMargin: Math.max(deps.oauthRefreshMarginMs ?? 10 * 60_000, oauthSkew),
  };
}
export type KeychainCtx = ReturnType<typeof keychainContext>;

export function keychainFilePath(path: string): string {
  if (/[\n\r]/.test(path))
    throw new KeychainError(400, `file path may not contain line breaks: ${JSON.stringify(path)}`);
  try {
    return homeRelativePath(path);
  } catch {
    throw new KeychainError(400, `file path must be home-relative: ${path}`);
  }
}

function credId(ownerId: string, service: string, slot: string): string {
  return hashId([ownerId, service, slot]);
}

function defaultEnvKey(service: string): string {
  return `${service.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPersonalCredentialEnvKey(envKey: string): boolean {
  return ENV_KEY_RE.test(envKey) && !envKey.startsWith("AGENT_");
}

function consumedGrant(grant: KeychainGrant): boolean {
  return grant.status === "used" || (grant.mode === "once" && grant.usedAt !== undefined);
}

export function expired(rec: { expiresAt?: number }, now: number): boolean {
  return typeof rec.expiresAt === "number" && rec.expiresAt < now;
}

export function credExpired(rec: { kind: CredentialKind; expiresAt?: number }, now: number): boolean {
  return rec.kind !== "file" && expired(rec, now);
}

export function toMeta(rec: Omit<KeychainCredential, "secretEnc"> & { secretEnc?: string }): KeychainCredentialMeta {
  const { secretEnc: _, ...meta } = rec;
  return {
    ...meta,
    ...((rec.kind === "env" || rec.kind === "file") && !isBackendCredential(rec)
      ? { credentialHandle: credentialHandle(rec) }
      : {}),
  };
}

export function owners(ownerIds: string[]): string[] {
  return ownerIds.flatMap((id) => personIds(id));
}

export function bucketByOwner<C extends { ownerId: string }, T>(
  creds: Iterable<C>,
  ownerIds: string[],
  include: (c: C) => boolean,
  item: (c: C) => T,
): Map<string, T[]> {
  const byKey = new Map(ownerIds.map((id) => [personKey(id), id]));
  const out = new Map<string, T[]>();
  for (const c of creds) {
    if (!include(c)) continue;
    const owner = byKey.get(personKey(c.ownerId));
    if (owner === undefined) continue;
    const list = out.get(owner) ?? [];
    list.push(item(c));
    out.set(owner, list);
  }
  return out;
}

export function checkedFiles(files: CredentialFile[]): CredentialFile[] {
  const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.contentBase64, "base64"), 0);
  if (files.length > MAX_CREDENTIAL_FILES || bytes > MAX_CREDENTIAL_BYTES)
    throw new KeychainError(
      413,
      `A saved login is limited to ${MAX_CREDENTIAL_FILES} files and ${MAX_CREDENTIAL_BYTES} bytes`,
    );
  return files;
}

export function listed(c: Pick<KeychainCredential, "managed" | "kind">): boolean {
  return !c.managed && c.kind !== "broker";
}

export function keychainRecords(c: KeychainCtx) {
  const { deps, store, now } = c;
  async function getOwned(ownerId: string, id: string): Promise<KeychainCredential | null> {
    const rec = await store.creds.get(id);
    return rec && samePerson(rec.ownerId, ownerId) ? rec : null;
  }

  function decryptToEnv(rec: KeychainCredential, extra?: { grantId: string; purpose: string }): MaterializedEnvCred {
    const raw = decryptSecret(rec.secretEnc, deps.key);
    let env: Array<{ key: string; value: string; secret?: boolean }>;
    if (rec.fields) {
      const values = JSON.parse(raw) as Record<string, string>;
      env = rec.fields.map((f) => ({ key: f.envKey, value: values[f.envKey] ?? "", secret: f.secret }));
    } else {
      env = [{ key: rec.envKey ?? defaultEnvKey(rec.service), value: raw }];
    }
    return {
      credentialId: rec.id,
      ownerId: rec.ownerId,
      service: rec.service,
      env,
      ...extra,
    };
  }

  function decryptToFiles(rec: KeychainCredential, extra?: { grantId: string; purpose: string }): MaterializedFileCred {
    const raw = decryptSecret(rec.secretEnc, deps.key);
    const files = JSON.parse(raw) as CredentialFile[];
    return {
      credentialId: rec.id,
      ownerId: rec.ownerId,
      service: rec.service,
      files,
      ...(rec.origin ? { origin: rec.origin } : {}),
      ...extra,
    };
  }

  function tryDecrypt<T>(rec: KeychainCredential, fn: (rec: KeychainCredential) => T): T | null {
    try {
      return fn(rec);
    } catch (err) {
      reportFailure(
        "keychain: credential does not decrypt under the current key",
        err,
        `${rec.id} (${rec.service}, owner ${rec.ownerId}) skipped`,
      );
      return null;
    }
  }

  async function activeGrantsFor(scopeId: ScopeId): Promise<KeychainGrant[]> {
    return store.grants.activeFor(scopeId, now());
  }

  const unsettled = (rec: KeychainAsk): boolean => rec.status === "pending" || rec.status === "expired";
  const askGrantId = (rec: KeychainAsk): string => hashId([rec.credentialId, "ask", rec.id]);

  async function freshAsks(recs: KeychainAsk[], t: number): Promise<KeychainAsk[]> {
    const ids = recs.filter(unsettled).map((rec) => rec.id);
    const grants = new Map(ids.length ? (await store.grants.forAsks(ids)).map((g) => [g.id, g] as const) : []);
    const out: KeychainAsk[] = [];
    for (const rec of recs) out.push(await settleAsk(rec, t, grants.get(askGrantId(rec)) ?? null));
    return out;
  }

  async function freshAsk(rec: KeychainAsk, t: number): Promise<KeychainAsk> {
    return settleAsk(rec, t, unsettled(rec) ? await store.grants.get(askGrantId(rec)) : null);
  }

  async function settleAsk(rec: KeychainAsk, t: number, grant: KeychainGrant | null): Promise<KeychainAsk> {
    if (!unsettled(rec)) return rec;
    if (grant?.askId === rec.id) {
      return (
        (await store.asks.update(rec.id, (current) =>
          current.status === "pending" || current.status === "expired"
            ? { ...current, status: "approved", resolvedAt: grant.createdAt, grantId: grant.id, notifiedAt: undefined }
            : current,
        )) ?? rec
      );
    }
    if (rec.status !== "pending" || rec.expiresAt >= t) return rec;
    return (
      (await store.asks.update(rec.id, (current) =>
        current.status === "pending" && current.expiresAt < t
          ? { ...current, status: "expired", resolvedAt: t }
          : current,
      )) ?? rec
    );
  }
  return { getOwned, decryptToEnv, decryptToFiles, tryDecrypt, activeGrantsFor, freshAsks, freshAsk };
}
type KeychainRecords = ReturnType<typeof keychainRecords>;

export function serviceCredentialRecords(c: KeychainCtx) {
  const { deps, store, now } = c;
  const brokerId = (orgScopeId: string, slug: string) => credId(orgScopeId, slug, "broker");
  const orgIdOf = (orgScopeId: string) => orgScopeId.replace(/^org:/, "");

  function brokerToPublic(rec: KeychainCredential): PublicServiceCredential {
    const b = rec.broker ?? { name: rec.service, enabled: true };
    return {
      slug: rec.service,
      name: b.name,
      delivery: b.delivery ?? "broker",
      ...(b.envKey ? { envKey: b.envKey } : {}),
      host: rec.host ?? "",
      ...(b.injection ? { injection: b.injection } : {}),
      ...(b.allowedMethods ? { allowedMethods: b.allowedMethods } : {}),
      ...(b.allowedPathPrefixes ? { allowedPathPrefixes: b.allowedPathPrefixes } : {}),
      deployments: b.deployments !== false,
      enabled: b.enabled,
      hasSecret: !!rec.secretEnc,
      ...(b.updatedBy ? { updatedBy: b.updatedBy } : {}),
      updatedAt: rec.updatedAt,
    };
  }

  async function brokerRecord(orgScopeId: string, slug: string): Promise<KeychainCredential | null> {
    return store.creds.get(brokerId(orgScopeId, slug));
  }

  function serviceCredentialRecord(
    orgScopeId: string,
    input: ServiceCredentialInput,
    prior: KeychainCredential | null,
  ): KeychainCredential {
    const injectionError = credentialInjectionError(input.injection);
    if (injectionError) throw new Error(injectionError);
    const trimmedSecret = input.secret?.trim();
    const t = Math.max(now(), (prior?.updatedAt ?? 0) + 1);
    const delivery = input.delivery ?? "broker";
    if (delivery === "env") {
      if (!input.envKey || !isValidServiceCredentialEnvKey(input.envKey)) {
        throw new Error(
          `env-delivery credential ${input.slug} needs an UPPER_SNAKE_CASE envKey outside AGENT_* (got ${JSON.stringify(input.envKey ?? null)})`,
        );
      }
    } else if (input.envKey) {
      throw new Error(`broker-delivery credential ${input.slug} must not carry an envKey`);
    }
    return {
      id: brokerId(orgScopeId, input.slug),
      ownerId: orgScopeId,
      orgId: orgIdOf(orgScopeId),
      service: input.slug,
      kind: "broker",
      host: input.host,
      broker: {
        name: input.name,
        ...(delivery === "env" ? { delivery, envKey: input.envKey! } : {}),
        ...(input.injection ? { injection: input.injection } : {}),
        ...(input.allowedMethods ? { allowedMethods: input.allowedMethods.map((m) => m.toUpperCase()) } : {}),
        ...(input.allowedPathPrefixes ? { allowedPathPrefixes: input.allowedPathPrefixes } : {}),
        ...(input.deployments === false ? { deployments: false } : {}),
        enabled: input.enabled !== false,
        ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
      },
      secretEnc: trimmedSecret ? encryptSecret(trimmedSecret, deps.key) : (prior?.secretEnc ?? ""),
      fingerprint: trimmedSecret ? fingerprintOf(trimmedSecret) : (prior?.fingerprint ?? ""),
      createdAt: prior?.createdAt ?? t,
      updatedAt: t,
    };
  }
  return { brokerId, brokerToPublic, brokerRecord, serviceCredentialRecord };
}
type ServiceCredentialRecords = ReturnType<typeof serviceCredentialRecords>;

export function connectorTokens(c: KeychainCtx, h: KeychainRecords) {
  const { deps, store, lock, now, oauthSkew, oauthRefreshMargin } = c;
  const { tryDecrypt } = h;
  const oauthSlot = (accountType?: string) => `oauth:${accountType && accountType !== "default" ? accountType : ""}`;
  const oauthId = (host: string, principalId: string, accountType?: string) =>
    credId(principalId, host.toLowerCase(), oauthSlot(accountType));

  async function putConnectorToken(
    host: string,
    principalId: string,
    token: OAuthToken,
    accountType?: string,
  ): Promise<KeychainCredential> {
    const t = now();
    const id = oauthId(host, principalId, accountType);
    const prior = await store.creds.get(id);
    const at = token.accountType ?? accountType;
    const rec: KeychainCredential = {
      id,
      ownerId: principalId,
      orgId: token.orgId ?? tenant().orgId,
      service: host.toLowerCase(),
      kind: "env",
      host: host.toLowerCase(),
      managed: "connector",
      secretEnc: encryptSecret(token.accessToken, deps.key),
      fingerprint: fingerprintOf(token.accessToken),
      origin: "connector-oauth",
      ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      refresh: {
        ...(token.refreshToken ? { refreshTokenEnc: encryptSecret(token.refreshToken, deps.key) } : {}),
        ...(token.idToken ? { idTokenEnc: encryptSecret(token.idToken, deps.key) } : {}),
        ...(token.accountId ? { accountId: token.accountId } : {}),
        ...(at ? { accountType: at } : {}),
        ...(token.clientRef ? { clientRef: token.clientRef } : {}),
        ...(token.grantedScopes ? { grantedScopes: token.grantedScopes } : {}),
        ...(token.orgId ? { orgId: token.orgId } : {}),
      },
      createdAt: prior?.createdAt ?? t,
      updatedAt: t,
    };
    await store.creds.put(rec.id, rec);
    return rec;
  }

  async function connectorRecord(
    host: string,
    principalId: string,
    accountType?: string,
  ): Promise<KeychainCredential | null> {
    return store.creds.get(oauthId(host, principalId, accountType));
  }

  function recToOAuthToken(rec: KeychainCredential): OAuthToken {
    return {
      accessToken: decryptSecret(rec.secretEnc, deps.key),
      ...(rec.refresh?.refreshTokenEnc ? { refreshToken: decryptSecret(rec.refresh.refreshTokenEnc, deps.key) } : {}),
      ...(rec.refresh?.idTokenEnc ? { idToken: decryptSecret(rec.refresh.idTokenEnc, deps.key) } : {}),
      ...(rec.refresh?.accountId ? { accountId: rec.refresh.accountId } : {}),
      ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
      ...(rec.refresh?.grantedScopes ? { grantedScopes: rec.refresh.grantedScopes } : {}),
      ...(rec.refresh?.clientRef ? { clientRef: rec.refresh.clientRef } : {}),
      ...(rec.refresh?.accountType ? { accountType: rec.refresh.accountType } : {}),
      ...(rec.refresh?.orgId ? { orgId: rec.refresh.orgId } : {}),
    };
  }

  function storedRefreshError(e: unknown): string {
    const msg = errMessage(e).replace(/\s+/g, " ").trim();
    return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
  }

  async function markConnectorRefreshFailure(rec: KeychainCredential, message: string): Promise<void> {
    await store.creds.markRefreshFailure(rec, now(), message);
  }

  const rotatedSince = (current: KeychainCredential, rec: KeychainCredential): boolean =>
    current.updatedAt !== rec.updatedAt || current.fingerprint !== rec.fingerprint;
  const rotatedToken = (current: KeychainCredential): string | null =>
    oauthExpired(current, now(), oauthSkew) ? null : (tryDecrypt(current, recToOAuthToken)?.accessToken ?? null);

  async function refreshAndStore(
    host: string,
    principalId: string,
    accountType: string | undefined,
    rec: KeychainCredential,
  ): Promise<string | null> {
    if (!deps.refreshConnector) return null;
    const refreshConnector = deps.refreshConnector;
    return lock.withLock(`keychain-refresh:${rec.id}`, async () => {
      const latest = await store.creds.get(rec.id);
      if (latest && rotatedSince(latest, rec)) return rotatedToken(latest);
      const stored = tryDecrypt(rec, recToOAuthToken);
      if (!stored) return null;
      try {
        const fresh = await refreshConnector(host, stored, {
          ...(stored.accountType ? { accountType: stored.accountType } : {}),
          ...(stored.clientRef ? { clientRef: stored.clientRef } : {}),
        });
        if (!fresh.accessToken) throw new Error("refresh returned an empty access token");
        const merged: OAuthToken = {
          ...(stored.clientRef ? { clientRef: stored.clientRef } : {}),
          ...(stored.accountType ? { accountType: stored.accountType } : {}),
          ...(stored.orgId ? { orgId: stored.orgId } : {}),
          ...(stored.idToken ? { idToken: stored.idToken } : {}),
          ...(stored.accountId ? { accountId: stored.accountId } : {}),
          ...fresh,
        };
        const current = await store.creds.get(rec.id);
        if (current && rotatedSince(current, rec)) return rotatedToken(current);
        await putConnectorToken(host, principalId, merged, accountType);
        return merged.accessToken;
      } catch (e) {
        const message = storedRefreshError(e);
        reportFailure("keychain: connector token refresh", e, host);
        await markConnectorRefreshFailure(rec, message).catch(
          reportFailureAs("keychain: connector token refresh failure metadata write", undefined, host),
        );
        return null;
      }
    });
  }

  async function connectorTokenForRecord(rec: KeychainCredential): Promise<string | null> {
    const t = now();
    const refreshable = rec.refresh?.refreshTokenEnc && deps.refreshConnector && rec.host ? rec.host : null;
    if (refreshable && rec.expiresAt !== undefined && t >= rec.expiresAt - oauthRefreshMargin) {
      return refreshAndStore(refreshable, rec.ownerId, rec.refresh?.accountType, rec);
    }
    if (oauthExpired(rec, t, oauthSkew) && !refreshable) return null;
    return tryDecrypt(rec, (r) => decryptSecret(r.secretEnc, deps.key));
  }
  return { oauthId, putConnectorToken, connectorRecord, recToOAuthToken, connectorTokenForRecord };
}
type ConnectorTokens = ReturnType<typeof connectorTokens>;

export function credentialWrites(c: KeychainCtx) {
  const { deps, store, now } = c;
  async function saveCredential(input: SaveCredentialInput): Promise<KeychainCredentialMeta> {
    const service = input.service.trim().toLowerCase();
    if (!service) throw new KeychainError(400, "service required");
    let files: CredentialFile[] | undefined;
    if (input.files?.length) {
      files = checkedFiles(input.files.map((f) => ({ ...f, path: keychainFilePath(f.path) })));
    } else if (input.target && input.secret) {
      files = [
        {
          path: keychainFilePath(input.target),
          contentBase64: Buffer.from(input.secret, "utf8").toString("base64"),
        },
      ];
    }
    const kind: CredentialKind = files ? "file" : "env";
    const fields =
      !files && input.fields?.length
        ? input.fields.map((f) => ({ envKey: f.envKey.trim(), value: f.value, secret: f.secret !== false }))
        : undefined;
    if (fields) {
      if (fields.some((f) => !isPersonalCredentialEnvKey(f.envKey)))
        throw new KeychainError(400, "each credential field needs a valid environment-variable envKey outside AGENT_*");
      if (fields.some((f) => !f.value || !f.value.trim()))
        throw new KeychainError(400, "each credential field needs a value");
      if (new Set(fields.map((f) => f.envKey)).size !== fields.length)
        throw new KeychainError(400, "credential field envKeys must be unique");
    }
    let secret = input.secret;
    if (files) secret = JSON.stringify(files);
    else if (fields) secret = JSON.stringify(Object.fromEntries(fields.map((f) => [f.envKey, f.value])));
    if (!secret || !secret.trim()) throw new KeychainError(400, "empty secret");
    const envKey = kind === "env" && !fields ? input.envKey?.trim() || defaultEnvKey(service) : undefined;
    if (envKey && !isPersonalCredentialEnvKey(envKey))
      throw new KeychainError(400, `envKey ${envKey} must be a valid environment-variable name outside AGENT_*`);
    const fieldsMeta = fields?.map((f) => ({ envKey: f.envKey, secret: f.secret }));
    const targets = files?.map((f) => f.path);
    const t = now();
    let slot = `env:${envKey}`;
    if (kind === "file") slot = "file";
    else if (fields)
      slot = `env:${fields
        .map((f) => f.envKey)
        .sort()
        .join(",")}`;
    const ownerId = canonicalPerson(input.ownerId);
    const id = credId(ownerId, service, slot);
    const buildRec = (prior?: KeychainCredential | null): KeychainCredential => {
      return {
        id,
        ownerId,
        orgId: tenant().orgId,
        service,
        kind,
        ...(envKey ? { envKey } : {}),
        ...(fieldsMeta ? { fields: fieldsMeta } : {}),
        ...(targets ? { targets } : {}),
        ...(input.host ? { host: input.host } : {}),
        ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}),
        secretEnc: encryptSecret(secret, deps.key),
        fingerprint: fingerprintOf(secret),
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        createdAt: prior?.createdAt ?? t,
        updatedAt: t,
      };
    };
    const rec = buildRec(await store.creds.get(id));
    await store.creds.put(rec.id, rec);
    return toMeta(rec);
  }
  return { saveCredential };
}
type CredentialWrites = ReturnType<typeof credentialWrites>;

export function grantRules(c: KeychainCtx, h: ConnectorTokens & KeychainRecords) {
  const { store, now } = c;
  const { decryptToEnv, decryptToFiles, tryDecrypt, connectorTokenForRecord } = h;
  async function materializeConnector(
    cred: KeychainCredential,
    extra?: { grantId: string; purpose: string },
  ): Promise<MaterializedCred> {
    if (!cred.host || !(await connectorTokenForRecord(cred))) {
      throw new KeychainError(
        410,
        "connector token expired and could not be refreshed — its owner must reconnect the app",
      );
    }
    return {
      kind: "connector",
      credentialId: cred.id,
      ownerId: cred.ownerId,
      service: cred.service,
      host: cred.host,
      ...(cred.refresh?.accountType ? { accountType: cred.refresh.accountType } : {}),
      ...extra,
    };
  }

  function materializeDecrypted(
    cred: KeychainCredential,
    extra?: { grantId: string; purpose: string },
  ): MaterializedCred {
    if (isBackendCredential(cred))
      throw new KeychainError(403, "Composio keys stay in the backend; use /v1/composio through the agent API");
    const materialized = tryDecrypt(cred, (c) =>
      c.kind === "file"
        ? { kind: "file" as const, ...decryptToFiles(c, extra) }
        : { kind: "env" as const, ...decryptToEnv(c, extra) },
    );
    if (!materialized) {
      throw new KeychainError(422, "credential does not decrypt under the current key");
    }
    return materialized;
  }

  async function claimOnceGrant(grant: KeychainGrant, scopeId: ScopeId, usedBy: string): Promise<void> {
    if (grant.mode !== "once") return;
    const usedAt = now();
    const claimed = await store.grants.update(grant.id, (current) => {
      if (current.audienceScopeId !== scopeId) throw new KeychainError(403, "grant is for a different conversation");
      if (current.status === "revoked") throw new KeychainError(410, "grant was revoked");
      if (consumedGrant(current)) throw new KeychainError(410, "one-time grant already used");
      if (expired(current, usedAt)) throw new KeychainError(410, "grant is expired");
      return { ...current, status: "used", usedAt, usedBy };
    });
    if (!claimed) throw new KeychainError(404, "unknown grant");
  }

  async function authorizedGrant(grantId: string, scopeId: ScopeId) {
    const grant = await store.grants.get(grantId);
    if (!grant) throw new KeychainError(404, "unknown grant");
    if (grant.audienceScopeId !== scopeId) throw new KeychainError(403, "grant is for a different conversation");
    if (grant.status === "revoked") throw new KeychainError(410, "grant was revoked");
    if (consumedGrant(grant)) throw new KeychainError(410, "one-time grant already used");
    if (expired(grant, now())) throw new KeychainError(410, "grant is expired");
    const cred = await store.creds.get(grant.credentialId);
    if (!cred) throw new KeychainError(404, "credential no longer exists");
    if (cred.kind === "broker") {
      throw new KeychainError(403, "broker credentials are not grantable — they are used via the credential broker");
    }
    if (cred.managed !== "connector" && credExpired(cred, now())) {
      throw new KeychainError(410, "credential is expired");
    }
    return { grant, cred };
  }

  async function prepareMaterialize(grantId: string, scopeId: ScopeId, usedBy: string) {
    const { grant, cred } = await authorizedGrant(grantId, scopeId);
    const extra = { grantId: grant.id, purpose: grant.purpose };
    const materialized =
      cred.managed === "connector" ? await materializeConnector(cred, extra) : materializeDecrypted(cred, extra);
    const version = cred.managed === "connector" ? await store.creds.get(cred.id) : cred;
    if (!version) throw new KeychainError(409, "credential changed while preparing execution; request it again");
    return {
      materialized,
      singleUse: grant.mode === "once",
      commit: async () => {
        const current = await authorizedGrant(grantId, scopeId);
        if (current.cred.updatedAt !== version.updatedAt || current.cred.secretEnc !== version.secretEnc) {
          throw new KeychainError(409, "credential changed while preparing execution; request it again");
        }
        await claimOnceGrant(current.grant, scopeId, usedBy);
      },
    };
  }

  async function mintGrant(input: CreateGrantInput): Promise<KeychainGrant> {
    const cred = await store.creds.get(input.credentialId);
    if (!cred) throw new KeychainError(404, "unknown credential");
    if (cred.kind === "broker") {
      throw new KeychainError(400, "broker credentials are org-owned and used via the credential broker, not grants");
    }
    if (!samePerson(cred.ownerId, input.ownerId)) {
      throw new KeychainError(
        403,
        "only the credential's owner can grant it — and only on a turn the owner themself sent",
      );
    }
    const purpose = input.purpose.trim();
    if (!purpose) throw new KeychainError(400, "purpose required — record the owner's approval verbatim");
    const t = now();
    if (!cred.managed && credExpired(cred, t)) throw new KeychainError(410, "credential is expired");
    const grant: KeychainGrant = {
      id: input.askId
        ? hashId([cred.id, "ask", input.askId])
        : hashId([cred.id, input.audienceScopeId, String(t), purpose]),
      credentialId: cred.id,
      ownerId: cred.ownerId,
      orgId: cred.orgId,
      audienceScopeId: input.audienceScopeId,
      mode: input.mode,
      purpose,
      status: "active",
      createdAt: t,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.askId ? { askId: input.askId } : {}),
    };
    if (input.askId) return store.grants.insertOrGet(grant.id, grant);
    await store.grants.put(grant.id, grant);
    return grant;
  }

  async function deleteCredential(id: string): Promise<void> {
    await store.grants.revokeForCredential(id, now());
    await store.creds.delete(id);
  }
  return { materializeConnector, materializeDecrypted, prepareMaterialize, mintGrant, deleteCredential };
}
type GrantRules = ReturnType<typeof grantRules>;

export type KeychainHelpers = KeychainRecords &
  ServiceCredentialRecords &
  ConnectorTokens &
  CredentialWrites &
  GrantRules;
