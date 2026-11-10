import type { Destination, ScopeId } from "../types.ts";
import type { TriggerBase } from "./types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { samePerson } from "../directory/person.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { fold } from "../identity/user-tenancy.ts";

export interface CreateTriggerInput {
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  destination?: Destination;
  ownerConsentedAt?: number;
  botActor?: boolean;
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
    ...(input.botActor ? { botActor: true } : {}),
  };
}

export async function setTriggerEnabled<T extends TriggerBase>(
  backing: DurableMap<T>,
  id: string,
  enabled: boolean,
): Promise<void> {
  await backing.merge(id, { enabled } as Partial<T>);
}

export async function ownedBy<T extends TriggerBase>(backing: DurableMap<T>, scopeId: string): Promise<T[]> {
  const field = "ownerScopeId" as Extract<keyof T, string>;
  const rows = await backing.select({ where: { field, anyOfFold: [scopeId] } });
  return rows.filter((row) => row.ownerScopeId === scopeId);
}

export const DROP_RECIPIENT_CONSENT_MIGRATION = {
  id: "durable-map/triggers/0001-drop-recipient-consent",
  statements: ["crons", "webhooks", "loops"].flatMap((table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    `UPDATE ${table} SET json = json - 'recipientConsent' WHERE json ? 'recipientConsent'`,
  ]),
};

export const BACKFILL_BOT_MARKER_MIGRATION = {
  id: "users/v2/0008-bot-marker-backfill",
  statements: [
    `DO $$
    BEGIN
      IF to_regclass('users') IS NULL OR to_regclass('user_links') IS NULL THEN
        RETURN;
      END IF;
${[
  ["crons", "createdBy"],
  ["loops", "createdBy"],
  ["monitors", "createdBy"],
  ["keychain_asks", "requesterId"],
]
  .map(
    ([table, creator]) => `      IF to_regclass('${table}') IS NOT NULL THEN
        UPDATE ${table} t SET json = t.json || '{"botActor": true}'::jsonb
          FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
         WHERE u.kind = 'app' AND l.tenant_id = t.tenant_id
           AND l.alias_id = ${fold(`t.json ->> '${creator}'`)} AND NOT t.json ? 'botActor';
        UPDATE durable_map_versions SET v = v + 1 WHERE tbl = '${table}';
      END IF;`,
  )
  .join("\n")}
    END $$`,
  ],
};
