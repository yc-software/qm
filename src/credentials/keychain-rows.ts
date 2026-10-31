import type { ScopeId } from "../types.ts";
import { personIds, samePerson } from "../directory/person.ts";
import { perTenant } from "../tenants/context.ts";
import type { KeychainAsk, KeychainCredential, KeychainGrant } from "./keychain.ts";

export interface KeychainCredentialRows {
  get(id: string): Promise<KeychainCredential | null>;
  put(rec: KeychainCredential): Promise<void>;
  insertIfAbsent(rec: KeychainCredential): Promise<boolean>;
  update(id: string, fn: (current: KeychainCredential) => KeychainCredential): Promise<KeychainCredential | null>;
  deleteIf(id: string, predicate: (current: KeychainCredential) => boolean): Promise<boolean>;
  delete(id: string): Promise<void>;
  byOwners(ownerIds: readonly string[]): Promise<KeychainCredential[]>;
  all(): Promise<KeychainCredential[]>;
}

export interface KeychainGrantRows {
  get(id: string): Promise<KeychainGrant | null>;
  put(grant: KeychainGrant): Promise<void>;
  putIfAbsent(grant: KeychainGrant): Promise<KeychainGrant>;
  update(id: string, fn: (current: KeychainGrant) => KeychainGrant): Promise<KeychainGrant | null>;
  revokeActive(filter: { id: string } | { credentialId: string }, revokedAt: number): Promise<void>;
  activeFor(audienceScopeId: ScopeId): Promise<KeychainGrant[]>;
  forCredential(credentialId: string): Promise<KeychainGrant[]>;
  byOwners(ownerIds: readonly string[]): Promise<KeychainGrant[]>;
  all(): Promise<KeychainGrant[]>;
}

export interface KeychainAskFilter {
  credentialId?: string;
  ownerId?: string;
  requesterId?: string;
  requesterScopeId?: ScopeId;
}

export interface KeychainAskRows {
  get(id: string): Promise<KeychainAsk | null>;
  put(ask: KeychainAsk): Promise<void>;
  update(id: string, fn: (current: KeychainAsk) => KeychainAsk): Promise<KeychainAsk | null>;
  delete(id: string): Promise<void>;
  newestFirst(filter: KeychainAskFilter): Promise<KeychainAsk[]>;
}

export interface KeychainRows {
  creds: KeychainCredentialRows;
  grants: KeychainGrantRows;
  asks: KeychainAskRows;
}

export function ownerKeys(ownerIds: readonly string[]): string[] {
  return [...new Set(ownerIds.flatMap((id) => personIds(id)).map((id) => id.toLowerCase()))];
}

export function matchesOwner(rec: { ownerId: string }, ownerIds: readonly string[]): boolean {
  return ownerIds.some((id) => samePerson(rec.ownerId, id));
}

export function askMatches(ask: KeychainAsk, filter: KeychainAskFilter): boolean {
  return (
    (filter.credentialId === undefined || ask.credentialId === filter.credentialId) &&
    (filter.requesterScopeId === undefined || ask.requesterScopeId === filter.requesterScopeId) &&
    (filter.ownerId === undefined || samePerson(ask.ownerId, filter.ownerId)) &&
    (filter.requesterId === undefined || samePerson(ask.requesterId, filter.requesterId))
  );
}

function newestFirst(a: KeychainAsk, b: KeychainAsk): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

function memoryTable<T extends { id: string }>() {
  const rows = perTenant(() => new Map<string, T>());
  const copy = (value: T | undefined): T | null => (value === undefined ? null : structuredClone(value));
  return {
    rows,
    copy,
    async get(id: string) {
      return copy(rows().get(id));
    },
    async put(value: T) {
      rows().set(value.id, structuredClone(value));
    },
    async update(id: string, fn: (current: T) => T) {
      const current = rows().get(id);
      if (current === undefined) return null;
      const next = { ...fn(structuredClone(current)), id };
      rows().set(id, structuredClone(next));
      return next;
    },
    async delete(id: string) {
      rows().delete(id);
    },
    list(predicate: (value: T) => boolean = () => true): T[] {
      return [...rows().values()]
        .sort((a, b) => Number(a.id > b.id) - Number(a.id < b.id))
        .filter(predicate)
        .map((value) => structuredClone(value));
    },
  };
}

export function memoryKeychainRows(): KeychainRows {
  const creds = memoryTable<KeychainCredential>();
  const grants = memoryTable<KeychainGrant>();
  const asks = memoryTable<KeychainAsk>();
  return {
    creds: {
      get: creds.get,
      put: creds.put,
      update: creds.update,
      delete: creds.delete,
      async insertIfAbsent(rec) {
        if (creds.rows().has(rec.id)) return false;
        await creds.put(rec);
        return true;
      },
      async deleteIf(id, predicate) {
        const current = creds.rows().get(id);
        if (current === undefined || !predicate(structuredClone(current))) return false;
        creds.rows().delete(id);
        return true;
      },
      async byOwners(ownerIds) {
        return creds.list((rec) => matchesOwner(rec, ownerIds));
      },
      async all() {
        return creds.list();
      },
    },
    grants: {
      get: grants.get,
      put: grants.put,
      update: grants.update,
      async putIfAbsent(grant) {
        const existing = grants.rows().get(grant.id);
        if (existing !== undefined) return structuredClone(existing);
        await grants.put(grant);
        return grant;
      },
      async revokeActive(filter, revokedAt) {
        for (const grant of grants.rows().values()) {
          if (grant.status !== "active") continue;
          if ("id" in filter ? grant.id !== filter.id : grant.credentialId !== filter.credentialId) continue;
          grants.rows().set(grant.id, { ...grant, status: "revoked", revokedAt });
        }
      },
      async activeFor(audienceScopeId) {
        return grants.list((g) => g.audienceScopeId === audienceScopeId && g.status === "active");
      },
      async forCredential(credentialId) {
        return grants.list((g) => g.credentialId === credentialId);
      },
      async byOwners(ownerIds) {
        return grants.list((grant) => matchesOwner(grant, ownerIds));
      },
      async all() {
        return grants.list();
      },
    },
    asks: {
      get: asks.get,
      put: asks.put,
      update: asks.update,
      delete: asks.delete,
      async newestFirst(filter) {
        return asks.list((ask) => askMatches(ask, filter)).sort(newestFirst);
      },
    },
  };
}
