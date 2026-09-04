import type { Destination, RecipientConsent, ScopeId, TriggerBase } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { samePerson } from "../directory/person.ts";

export interface CreateTriggerInput {
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  destination?: Destination;
  ownerConsentedAt?: number;
  recipientConsent?: RecipientConsent;
}

export function consentRequiredRecipient(input: {
  owner: string;
  standing: boolean;
  destination?: Destination;
}): string | undefined {
  if (!input.standing) return undefined;
  const d = input.destination;
  return d?.type === "principal" && !samePerson(d.target, input.owner) ? d.target : undefined;
}

export function recipientConsentSatisfied(
  input: { recipientConsent?: RecipientConsent },
  requiredRecipient?: string,
): boolean {
  if (!requiredRecipient) return input.recipientConsent === undefined || input.recipientConsent.status === "accepted";
  return (
    input.recipientConsent?.status === "accepted" && samePerson(input.recipientConsent.recipientId, requiredRecipient)
  );
}

export function decideRecipientConsent(
  current: RecipientConsent | undefined,
  actorId: string,
  decision: "accept" | "decline",
  now: number,
): { ok: true; consent: RecipientConsent } | { ok: false; reason: "no_consent" | "not_recipient" } {
  if (!current) return { ok: false, reason: "no_consent" };
  if (!samePerson(current.recipientId, actorId)) return { ok: false, reason: "not_recipient" };
  return { ok: true, consent: { ...current, status: decision === "accept" ? "accepted" : "declined", decidedAt: now } };
}

export function contentPart(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value, (_k, v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      }),
    );
  });
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
    ...(input.recipientConsent ? { recipientConsent: input.recipientConsent } : {}),
  };
}

export async function setTriggerEnabled<T extends TriggerBase>(
  backing: DurableMap<T>,
  id: string,
  enabled: boolean,
): Promise<void> {
  await backing.merge(id, { enabled } as Partial<T>);
}

export async function setTriggerRecipientConsent<T extends TriggerBase>(
  backing: DurableMap<T>,
  id: string,
  recipientConsent: RecipientConsent,
): Promise<void> {
  await backing.merge(id, { recipientConsent } as Partial<T>);
}
