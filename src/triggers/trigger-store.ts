import type { Destination, ScopeId, TriggerBase } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { samePerson } from "../directory/person.ts";
import { canonicalJson } from "../util/objects.ts";

export interface CreateTriggerInput {
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  destination?: Destination;
  ownerConsentedAt?: number;
}

export function contentPart(value: unknown): string {
  return canonicalJson(value);
}

export function createDeduped<T extends { id: string }>(
  backing: DurableMap<T>,
  contentId: string,
  build: (id: string) => T,
): Promise<T> {
  return backing.putIfAbsent(contentId, build(contentId));
}

export function assertNoEscalation(input: { owner: string; createdBy: string; ownerConsentedAt?: number }): void {
  if (!samePerson(input.owner, input.createdBy) && !input.ownerConsentedAt) {
    throw new Error("assigning a different owner requires that owner's consent");
  }
}

export function buildTriggerBase(input: CreateTriggerInput, id: string, createdAt: number): TriggerBase {
  return {
    id,
    ownerScopeId: input.ownerScopeId,
    owner: input.owner,
    createdBy: input.createdBy,
    enabled: true,
    createdAt,
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.ownerConsentedAt ? { ownerConsentedAt: input.ownerConsentedAt } : {}),
  };
}

export async function setTriggerEnabled<T extends TriggerBase>(
  backing: DurableMap<T>,
  id: string,
  enabled: boolean,
): Promise<void> {
  await backing.merge(id, { enabled } as Partial<T>);
}

export const DROP_RECIPIENT_CONSENT_MIGRATION = {
  id: "durable-map/triggers/0001-drop-recipient-consent",
  statements: ["crons", "webhooks", "loops"].flatMap((table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    `UPDATE ${table} SET json = json - 'recipientConsent' WHERE json ? 'recipientConsent'`,
  ]),
};
