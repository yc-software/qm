import { fold } from "../identity/user-tenancy.ts";
import type { Destination, ScopeId } from "../types.ts";
import type { TriggerBase } from "./types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { samePerson } from "../directory/person.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";

export interface CreateTriggerInput {
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  destination?: Destination;
  botActor?: boolean;
}

export function contentPart(value: unknown): string {
  return canonicalJson(value);
}

export function normalizeTitle(title: string | undefined): string | undefined {
  return title?.trim().replace(/\s+/g, " ") || undefined;
}

export function createDeduped<T extends { id: string }>(
  backing: DurableMap<T>,
  contentId: string,
  build: (id: string) => T,
): Promise<T> {
  return backing.putIfAbsent(contentId, build(contentId));
}

export function assertNoEscalation(input: { owner: string; createdBy: string }): void {
  if (!samePerson(input.owner, input.createdBy)) {
    throw new Error("a trigger's owner must be the person who creates it");
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

export const markBotWork = (skip = "", users?: string): string => `DO $$
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
         WHERE u.kind = 'app' AND l.tenant_id = t.tenant_id${users ? ` AND u.id = ANY(${users})` : ""}
           AND l.alias_id = ${fold(`t.json ->> '${creator}'`)} AND NOT t.json ? 'botActor'${skip};
        ${
          users
            ? `IF FOUND THEN
          UPDATE durable_map_versions SET v = v + 1
           WHERE tbl = '${table}' AND tenant_id IN (SELECT tenant_id FROM users WHERE id = ANY(${users}));
        END IF;`
            : `UPDATE durable_map_versions SET v = v + 1 WHERE tbl = '${table}';`
        }
      END IF;`,
  )
  .join("\n")}
    END $$`;

export const unlessSlackListsAPerson = (link: string): string => `
           AND NOT EXISTS (SELECT 1 FROM directory_members m WHERE m.tenant_id = ${link}.tenant_id AND m.is_bot IS FALSE
                              AND ${fold("m.principal_id")} = ${link}.alias_id)
           AND NOT EXISTS (SELECT 1 FROM directory_members m WHERE m.tenant_id = ${link}.tenant_id AND m.is_bot IS FALSE
                              AND m.slack_id = ${link}.alias_id)`;
