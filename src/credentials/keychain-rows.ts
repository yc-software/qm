import type { ScopeId } from "../types.ts";
import { personIds, samePerson } from "../directory/person.ts";
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
