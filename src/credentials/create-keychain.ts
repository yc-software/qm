import { randomBytes } from "node:crypto";
import { scopeId as toScopeId, parseScopeId } from "../types.ts";
import { encryptSecret, decryptSecret } from "../connectors/connector-client-store.ts";
import { samePerson } from "../directory/person.ts";
import { cronIdOf } from "../sessions/thread-ref.ts";
import { tenant } from "../tenant.ts";
import {
  ASK_PRUNE_AFTER_MS,
  ASK_TTL_MS,
  COMPOSIO_ENV_KEY,
  connectorMeta,
  credentialFilesFingerprint,
  fingerprintOf,
  isBackendCredential,
  type Keychain,
  type KeychainAsk,
  type KeychainCredentialMeta,
  KeychainError,
  type KeychainGrant,
  type MaterializedEnvCred,
  type MaterializedFileCred,
  oauthExpired,
} from "./keychain.ts";
import {
  keychainContext,
  keychainFilePath,
  expired,
  credExpired,
  toMeta,
  owners,
  bucketByOwner,
  checkedFiles,
  listed,
  keychainRecords,
  serviceCredentialRecords,
  connectorTokens,
  credentialWrites,
  grantRules,
  type KeychainDeps,
  type KeychainCtx,
  type KeychainHelpers,
} from "./keychain-core.ts";

function credentialMethods(c: KeychainCtx, h: KeychainHelpers) {
  const { deps, store, now } = c;
  return {
    save: h.saveCredential,

    async updateFiles(materialized, files) {
      if (materialized.grantId) return;
      const normalized = checkedFiles(files.map((file) => ({ ...file, path: keychainFilePath(file.path) })));
      if (!normalized.length) throw new KeychainError(409, "Refreshed credential files are missing");
      const fingerprint = credentialFilesFingerprint;
      if (fingerprint(normalized) === fingerprint(materialized.files)) return;
      const updated = await store.creds.update(materialized.credentialId, (current) => {
        if (current.kind !== "file" || !samePerson(current.ownerId, materialized.ownerId))
          throw new KeychainError(409, "Credential changed during execution");
        const currentFiles = h.decryptToFiles(current).files;
        if (fingerprint(currentFiles) === fingerprint(normalized)) return current;
        if (fingerprint(currentFiles) !== fingerprint(materialized.files))
          throw new KeychainError(409, "Credential changed during execution; refreshed files were not saved");
        const secret = JSON.stringify(normalized);
        return {
          ...current,
          targets: normalized.map((file) => file.path),
          secretEnc: encryptSecret(secret, deps.key),
          fingerprint: fingerprintOf(secret),
          updatedAt: now(),
        };
      });
      if (!updated) throw new KeychainError(410, "Credential was removed during execution");
    },

    async writebackBaseline(source, fingerprint) {
      const current = await store.creds.get(source.credentialId);
      if (!current || current.kind !== "file" || !samePerson(current.ownerId, source.ownerId))
        throw new KeychainError(410, "Credential was removed during execution");
      const files = h.decryptToFiles(current).files;
      if (credentialFilesFingerprint(files) !== fingerprint)
        throw new KeychainError(409, "Credential changed during execution; refreshed files were not saved");
      return {
        kind: "file",
        credentialId: current.id,
        ownerId: current.ownerId,
        service: current.service,
        files,
        ...(source.grantId ? { grantId: source.grantId } : {}),
      };
    },

    async listAllMetadata() {
      return (await store.creds.all()).filter(listed).map(toMeta);
    },

    async listByOwner(ownerId) {
      return (await store.creds.byOwners(owners([ownerId])))
        .filter((c) => samePerson(c.ownerId, ownerId) && listed(c))
        .map(toMeta);
    },

    async listByOwners(ownerIds) {
      return bucketByOwner(await store.creds.byOwners(owners(ownerIds)), ownerIds, listed, toMeta);
    },

    async getCredential(id) {
      const rec = await store.creds.get(id);
      return rec ? toMeta(rec) : null;
    },

    async readOwnSecret(ownerId, id) {
      const rec = await h.getOwned(ownerId, id);
      if (!rec || rec.kind !== "env") return null;
      return h.tryDecrypt(rec, (r) => decryptSecret(r.secretEnc, deps.key));
    },

    async remove(ownerId, id) {
      const rec = await h.getOwned(ownerId, id);
      if (!rec) return false;
      if (rec.managed || rec.kind === "broker") return false;
      await h.deleteCredential(id);
      return true;
    },
  } satisfies Partial<Keychain>;
}

function grantMethods(c: KeychainCtx, h: KeychainHelpers) {
  const { store, now } = c;
  return {
    createGrant: h.mintGrant,

    async getGrant(id) {
      return (await store.grants.get(id)) ?? null;
    },

    async listGrants(filter) {
      const grants = await store.grants.list(filter.ownerId === undefined ? undefined : owners([filter.ownerId]));
      return grants.filter(
        (g) =>
          (filter.ownerId === undefined || samePerson(g.ownerId, filter.ownerId)) &&
          (filter.audienceScopeId === undefined || g.audienceScopeId === filter.audienceScopeId),
      );
    },

    async revokeGrant(ownerId, grantId) {
      const g = await store.grants.get(grantId);
      if (!g || !samePerson(g.ownerId, ownerId)) return false;
      if (g.status === "active") await store.grants.revoke(grantId, now());
      return true;
    },

    async grantsForScope(scopeId) {
      const out: Array<{ grant: KeychainGrant; credential: KeychainCredentialMeta }> = [];
      for (const grant of await h.activeGrantsFor(scopeId)) {
        const cred = await store.creds.get(grant.credentialId);
        if (cred && (cred.managed === "connector" || !credExpired(cred, now())))
          out.push({ grant, credential: toMeta(cred) });
      }
      return out;
    },
  } satisfies Partial<Keychain>;
}

function askMethods(c: KeychainCtx, h: KeychainHelpers) {
  const { store, lock, now } = c;
  return {
    async createAsk(input) {
      const purpose = input.purpose.trim();
      if (!purpose)
        throw new KeychainError(400, "purpose required — describe the specific task requiring this credential");
      const cred = await store.creds.get(input.credentialId);
      if (!cred || cred.kind === "broker") throw new KeychainError(404, "unknown credential");
      const t = now();
      if (!cred.managed && credExpired(cred, t))
        throw new KeychainError(410, "credential is expired — its owner must re-auth before it can be asked for");
      const scope = parseScopeId(input.requesterScopeId);
      if (
        scope.kind === "personal" &&
        (!samePerson(scope.ref, input.requesterId) || !samePerson(cred.ownerId, input.requesterId))
      ) {
        throw new KeychainError(403, "personal requests require the credential owner's own conversation");
      }
      const origin = cronIdOf(input.requesterThreadRef) ?? input.requesterThreadRef;
      for (const a of await h.freshAsks(await store.asks.list(true), t)) {
        const sameOrigin = (cronIdOf(a.requesterThreadRef) ?? a.requesterThreadRef) === origin;
        if (a.credentialId !== cred.id || a.requesterScopeId !== input.requesterScopeId || !sameOrigin) continue;
        if (a.status === "pending") return { ask: a, existing: true };
        if (a.status === "approved") break;
        if (input.triggered && (a.status === "declined" || a.status === "expired")) {
          throw new KeychainError(
            409,
            "the owner declined or did not answer this task's request — wait for a live owner turn instead of asking again",
          );
        }
      }
      const ask: KeychainAsk = {
        id: randomBytes(6).toString("hex"),
        credentialId: cred.id,
        ownerId: cred.ownerId,
        requesterId: input.requesterId,
        orgId: tenant().orgId,
        requesterScopeId: input.requesterScopeId,
        ...(input.requesterDestination ? { requesterDestination: input.requesterDestination } : {}),
        ...(input.requesterThreadRef ? { requesterThreadRef: input.requesterThreadRef } : {}),
        ...(input.requesterSeq !== undefined ? { requesterSeq: input.requesterSeq } : {}),
        ...(input.requesterMessageTs ? { requesterMessageTs: input.requesterMessageTs } : {}),
        purpose,
        ...(input.requestedMode ? { requestedMode: input.requestedMode } : {}),
        status: "pending",
        createdAt: t,
        expiresAt: input.expiresAt ?? t + ASK_TTL_MS,
      };
      await store.asks.put(ask.id, ask);
      return { ask, existing: false };
    },

    async getAsk(id) {
      const rec = await store.asks.get(id);
      return rec ? h.freshAsk(rec, now()) : null;
    },

    async listAsks(filter) {
      const t = now();
      const out: KeychainAsk[] = [];
      for (const a of await h.freshAsks(await store.asks.list(false), t)) {
        if (filter.requesterId !== undefined && !samePerson(a.requesterId, filter.requesterId)) continue;
        if (filter.ownerId !== undefined && !samePerson(a.ownerId, filter.ownerId)) continue;
        if (filter.requesterScopeId !== undefined && a.requesterScopeId !== filter.requesterScopeId) continue;
        out.push(a);
      }
      return out;
    },

    async approveAsk(input) {
      return lock.withLock(`keychain-ask:${input.askId}`, async () => {
        const rec = await store.asks.get(input.askId);
        if (!rec) throw new KeychainError(404, "unknown ask");
        const t = now();
        const ask = await h.freshAsk(rec, t);
        if (ask.status !== "pending") throw new KeychainError(410, `ask already ${ask.status}`);
        const grant = await h.mintGrant({
          credentialId: ask.credentialId,
          ownerId: input.ownerId,
          audienceScopeId: ask.requesterScopeId,
          mode: input.mode,
          purpose: input.purpose,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          askId: ask.id,
        });
        const patch = { status: "approved" as const, resolvedAt: t, grantId: grant.id, notifiedAt: undefined };
        await store.asks.merge(ask.id, patch);
        return { ask: { ...ask, ...patch }, grant };
      });
    },

    async declineAsk(input) {
      return lock.withLock(`keychain-ask:${input.askId}`, async () => {
        const rec = await store.asks.get(input.askId);
        if (!rec) throw new KeychainError(404, "unknown ask");
        if (!samePerson(rec.ownerId, input.ownerId))
          throw new KeychainError(403, "only the credential's owner can decline an ask");
        const t = now();
        const ask = await h.freshAsk(rec, t);
        if (ask.status !== "pending") throw new KeychainError(410, `ask already ${ask.status}`);
        const note = input.note?.trim();
        const patch = { status: "declined" as const, resolvedAt: t, ...(note ? { note } : {}) };
        await store.asks.merge(ask.id, patch);
        return { ...ask, ...patch };
      });
    },

    async unnotifiedResolvedAsks(nowAt) {
      const out: KeychainAsk[] = [];
      const taskDecisions = new Set<string>();
      const liveCredentials = new Map<string, Promise<boolean>>();
      const credentialLive = (id: string): Promise<boolean> => {
        const known = liveCredentials.get(id);
        if (known) return known;
        const lookup = store.creds.get(id).then(Boolean);
        liveCredentials.set(id, lookup);
        return lookup;
      };
      for (const a of await h.freshAsks(await store.asks.list(true), nowAt)) {
        const origin = cronIdOf(a.requesterThreadRef) ?? a.requesterThreadRef;
        const task = JSON.stringify([a.credentialId, a.requesterScopeId, origin]);
        const latestForTask = origin !== undefined && !taskDecisions.has(task);
        taskDecisions.add(task);
        if (a.status === "pending") continue;
        if (a.notifiedAt === undefined) out.push(a);
        else if (
          a.notifiedAt < nowAt - ASK_PRUNE_AFTER_MS &&
          !(latestForTask && (await credentialLive(a.credentialId)))
        )
          await store.asks.delete(a.id);
      }
      return out;
    },

    async markAskNotified(id, status) {
      await store.asks.update(id, (current) =>
        current.status === status ? { ...current, notifiedAt: now() } : current,
      );
    },
  } satisfies Partial<Keychain>;
}

function serviceMethods(c: KeychainCtx, h: KeychainHelpers) {
  const { deps, store, now, oauthSkew } = c;
  return {
    async setServiceCredential(orgScopeId, input) {
      const prior = await h.brokerRecord(orgScopeId, input.slug);
      const rec = h.serviceCredentialRecord(orgScopeId, input, prior);
      await store.creds.put(rec.id, rec);
    },

    async setServiceCredentialIfAbsent(orgScopeId, input) {
      const rec = h.serviceCredentialRecord(orgScopeId, input, null);
      return (await store.creds.insert(rec.id, rec)) ? rec.updatedAt : null;
    },

    async setServiceCredentialIfCurrent(orgScopeId, input, expectedUpdatedAt) {
      let updatedAt: number | null = null;
      await store.creds.update(h.brokerId(orgScopeId, input.slug), (prior) => {
        if (prior.kind !== "broker" || prior.ownerId !== orgScopeId || prior.updatedAt !== expectedUpdatedAt)
          return prior;
        const next = h.serviceCredentialRecord(orgScopeId, input, prior);
        updatedAt = next.updatedAt;
        return next;
      });
      return updatedAt;
    },

    async listServiceCredentials(orgScopeId) {
      return (await store.creds.byOwners(owners([orgScopeId])))
        .filter((c) => c.kind === "broker" && c.ownerId === orgScopeId)
        .map(h.brokerToPublic);
    },

    async deleteServiceCredential(orgScopeId, slug) {
      await store.creds.delete(h.brokerId(orgScopeId, slug));
    },

    async deleteServiceCredentialIfCurrent(orgScopeId, slug, expectedUpdatedAt) {
      return store.creds.deleteBrokerIfCurrent(h.brokerId(orgScopeId, slug), orgScopeId, expectedUpdatedAt);
    },

    async getServiceCredentialSecret(orgScopeId, slug) {
      const rec = await h.brokerRecord(orgScopeId, slug);
      if (!rec?.secretEnc) return null;
      const {
        hasSecret: _hasSecret,
        updatedBy: _updatedBy,
        updatedAt: _updatedAt,
        ...projected
      } = h.brokerToPublic(rec);
      return { ...projected, secret: decryptSecret(rec.secretEnc, deps.key) };
    },

    async setConnectorToken(host, principalId, token, accountType) {
      await h.putConnectorToken(host, principalId, token, accountType);
    },

    async deleteConnectorToken(host, principalId, accountType) {
      await h.deleteCredential(h.oauthId(host, principalId, accountType));
    },

    async connectorTokenStatus(host, principalId, accountType) {
      const rec = await h.connectorRecord(host, principalId, accountType);
      if (!rec) return { connected: false };
      const hasRefresh = !!rec.refresh?.refreshTokenEnc;
      const refreshFailedAt = rec.refresh?.refreshFailedAt;
      const refreshFailed = typeof refreshFailedAt === "number";
      const tokenExpired = oauthExpired(rec, now(), oauthSkew);
      return {
        connected: true,
        ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
        ...(hasRefresh ? { hasRefreshToken: true } : {}),
        ...(tokenExpired && (!hasRefresh || refreshFailed) ? { needsReconnect: true } : {}),
        ...(refreshFailed ? { refreshFailedAt } : {}),
        ...(refreshFailed && rec.refresh?.refreshError ? { refreshError: rec.refresh.refreshError } : {}),
        ...(rec.refresh?.accountType ? { accountType: rec.refresh.accountType } : {}),
        ...(rec.refresh?.grantedScopes ? { grantedScopes: rec.refresh.grantedScopes } : {}),
      };
    },

    async connectorAccessToken(host, principalId, accountType) {
      const rec = await h.connectorRecord(host, principalId, accountType);
      if (!rec) return null;
      return h.connectorTokenForRecord(rec);
    },

    async connectorDerivedAuth(host, principalId, accountType) {
      const rec = await h.connectorRecord(host, principalId, accountType);
      if (!rec) return null;
      const accessToken = await h.connectorTokenForRecord(rec);
      if (accessToken === null) return null;
      const fresh = (await h.connectorRecord(host, principalId, accountType)) ?? rec;
      const token = h.tryDecrypt(fresh, h.recToOAuthToken);
      if (!token) return null;
      return {
        accessToken: token.accessToken,
        ...(token.idToken ? { idToken: token.idToken } : {}),
        ...(token.accountId ? { accountId: token.accountId } : {}),
        ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      };
    },

    async listConnectorsByOwners(ownerIds) {
      const t = now();
      return bucketByOwner(
        await store.creds.byOwners(owners(ownerIds)),
        ownerIds,
        (c) => c.managed === "connector",
        (c) => connectorMeta(c, t, oauthSkew),
      );
    },
  } satisfies Partial<Keychain>;
}

function materializeMethods(c: KeychainCtx, h: KeychainHelpers) {
  const { store, now } = c;
  return {
    async composioKey(ownerId, credentialId) {
      const cred = await h.getOwned(ownerId, credentialId);
      if (!cred || cred.kind !== "env" || !isBackendCredential(cred) || credExpired(cred, now())) return null;
      return h.tryDecrypt(cred, h.decryptToEnv)?.env.find((e) => e.key === COMPOSIO_ENV_KEY)?.value ?? null;
    },
    prepareMaterialize: h.prepareMaterialize,

    async materializeOwnById(ownerId, credentialId, scopeId) {
      if (scopeId !== toScopeId("personal", ownerId)) {
        throw new KeychainError(
          403,
          "a credential id loads only in its owner's own personal conversation — anywhere else needs a grant from the owner",
        );
      }
      const cred = await store.creds.get(credentialId);
      if (!cred || !samePerson(cred.ownerId, ownerId)) throw new KeychainError(404, "unknown credential");
      if (cred.kind === "broker") {
        throw new KeychainError(403, "broker credentials are used via the credential broker, never materialized");
      }
      if (cred.managed === "connector") return h.materializeConnector(cred);
      if (credExpired(cred, now())) throw new KeychainError(410, "credential is expired");
      return h.materializeDecrypted(cred);
    },

    async materializeOwn(ownerId) {
      const t = now();
      return (await store.creds.byOwners(owners([ownerId])))
        .filter(
          (c) =>
            samePerson(c.ownerId, ownerId) &&
            c.kind === "env" &&
            !c.managed &&
            !isBackendCredential(c) &&
            !expired(c, t),
        )
        .map((c) => h.tryDecrypt(c, h.decryptToEnv))
        .filter((c): c is MaterializedEnvCred => c !== null);
    },

    async materializeOwnFiles(ownerId) {
      return (await store.creds.byOwners(owners([ownerId])))
        .filter((c) => samePerson(c.ownerId, ownerId) && c.kind === "file" && listed(c))
        .map((c) => h.tryDecrypt(c, h.decryptToFiles))
        .filter((c): c is MaterializedFileCred => c !== null);
    },
  } satisfies Partial<Keychain>;
}

export function createKeychain(deps: KeychainDeps): Keychain {
  const c = keychainContext(deps);
  const records = keychainRecords(c);
  const tokens = connectorTokens(c, records);
  const h = {
    ...records,
    ...serviceCredentialRecords(c),
    ...tokens,
    ...credentialWrites(c),
    ...grantRules(c, { ...records, ...tokens }),
  };
  return {
    ...credentialMethods(c, h),
    ...grantMethods(c, h),
    ...askMethods(c, h),
    ...serviceMethods(c, h),
    ...materializeMethods(c, h),
  };
}
