import type { Destination, ScopeId } from "../types.ts";
import type { TriggerBase } from "./types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { samePerson } from "../directory/person.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { fold } from "../identity/user-tenancy.ts";
import { msOf } from "../sessions/items.ts";

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

export const DROP_RETIRED_TRIGGER_FIELDS_MIGRATION = {
  id: "durable-map/triggers/0002-drop-retired-fields",
  statements: ["crons", "webhooks", "loops", "monitors"].flatMap((table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    `UPDATE ${table} SET json = json - 'recipientConsent' - 'taskAuthor' - 'ownerConsentedAt'
       WHERE json ?| ARRAY['recipientConsent', 'taskAuthor', 'ownerConsentedAt']`,
  ]),
};

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

export const BACKFILL_BOT_MARKER_MIGRATION = {
  id: "users/v2/0008-bot-marker-backfill",
  statements: [markBotWork()],
};

export const unlessSlackListsAPerson = (link: string): string => `
           AND NOT EXISTS (SELECT 1 FROM directory_members m WHERE m.tenant_id = ${link}.tenant_id AND m.is_bot IS FALSE
                              AND ${fold("m.principal_id")} = ${link}.alias_id)
           AND NOT EXISTS (SELECT 1 FROM directory_members m WHERE m.tenant_id = ${link}.tenant_id AND m.is_bot IS FALSE
                              AND m.slack_id = ${link}.alias_id)`;

export const RERUN_BOT_MARKER_BACKFILL_MIGRATION = {
  id: "users/v2/0010-rerun-bot-marker-backfill",
  statements: [markBotWork(unlessSlackListsAPerson("l"))],
};

export const MARK_BOT_EDITED_CRONS_MIGRATION = {
  id: "triggers/0001-mark-bot-edited-crons",
  statements: [
    `DO $$
    BEGIN
      IF to_regclass('items') IS NULL OR to_regclass('runs') IS NULL OR to_regclass('crons') IS NULL
         OR to_regclass('audit_log') IS NULL THEN
        RETURN;
      END IF;
      WITH bot_patches AS MATERIALIZED (
        SELECT c.tenant_id, c.body ->> 'id' AS cron_id, c.created_at, r.id AS run_id, r.session_id AS thread_ref,
               COALESCE(CASE WHEN pg_input_is_valid(c.body -> 'wire' ->> 'argumentsJson', 'jsonb')
                             THEN (c.body -> 'wire' ->> 'argumentsJson')::jsonb END, c.body - 'wire') AS args
          FROM items c
          JOIN items res ON res.tenant_id = c.tenant_id AND res.session_id = c.session_id AND res.kind = 'ToolResult'
                        AND md5(res.call_id) = md5(c.call_id) AND res.call_id = c.call_id
          JOIN runs r ON r.tenant_id = c.tenant_id AND r.id = c.turn_id::text
         WHERE c.kind = 'ToolCall' AND c.tool = 'cron' AND c.body ->> 'action' = 'patch' AND res.is_error IS NOT TRUE
           AND pg_input_is_valid(r.request, 'jsonb') AND r.request::jsonb ->> 'botActor' = 'true'
      ), found AS (
        SELECT DISTINCT ON (k.tenant_id, k.id) k.tenant_id, k.id, k.json ->> 'ownerScopeId' AS scope, p.run_id,
               p.thread_ref,
               COALESCE(k.json ->> 'action' = p.args ->> 'task' OR k.json ->> 'message' = p.args ->> 'text'
                 OR (k.json #>> '{script,command}' = p.args #>> '{script,command}'
                     AND k.json #> '{script,credentials}'
                         IS NOT DISTINCT FROM NULLIF(p.args #> '{script,credentials}', '[]')),
                 false) AS bot_text
          FROM bot_patches p JOIN crons k ON k.tenant_id = p.tenant_id AND k.id = p.cron_id
         WHERE k.json ->> 'botActor' IS DISTINCT FROM 'true'
         ORDER BY k.tenant_id, k.id, bot_text DESC, p.created_at DESC
      ), marked AS (
        UPDATE crons k SET json = k.json || '{"botActor": true}'::jsonb
          FROM found f WHERE f.bot_text AND k.tenant_id = f.tenant_id AND k.id = f.id
        RETURNING k.tenant_id
      ), versions AS (
        UPDATE durable_map_versions SET v = v + 1 WHERE tbl = 'crons' AND tenant_id IN (SELECT tenant_id FROM marked)
      )
      INSERT INTO audit_log (tenant_id, at, principal_id, action, resource, scope_label, detail)
      SELECT tenant_id, ${msOf("now()")}, 'system:migration',
             CASE WHEN bot_text THEN 'cron_update' ELSE 'cron_bot_marker_review' END, id, scope,
             (jsonb_build_object('runId', run_id, 'threadRef', thread_ref)
               || CASE WHEN bot_text THEN '{"botActor": true}'::jsonb ELSE '{}' END)::text
        FROM found;
    END $$`,
  ],
};
