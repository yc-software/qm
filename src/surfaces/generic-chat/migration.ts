import type { PgMigrationDefinition } from "../../persistence/pg-pool.ts";
import { servingTenant } from "../../tenants/claim.ts";
import { tenantKeyFunction } from "../../tenants/lookup.ts";
import { GENERIC_CHAT } from "./protocol.ts";

const RETIRED = "partner-chat";

const IDENTIFIERS: Record<string, readonly string[]> = {
  sessions: ["thread_ref", "scope_id", "surface"],
  runs: ["session_id", "idempotency_key"],
  run_signals: ["dedupe_key"],
  deliveries: ["idempotency_key", "recipient_thread_ref"],
  cron_fires: ["thread_ref"],
  participants: ["principal_id"],
  channel_messages: ["container", "surface"],
  channel_files: ["container", "surface"],
  channel_state: ["container", "surface"],
  channel_policy: ["container"],
  channel_policy_history: ["container"],
  ambient_judgments: ["container", "surface"],
  ack_emoji_picks: ["surface", "channel"],
  directory_groups: ["group_id", "surface"],
  directory_group_members: ["group_id", "principal_id"],
  directory_members: ["principal_id"],
  directory_channel_members: ["principal_id"],
  user_links: ["alias_id"],
  users: ["primary_alias"],
  admin_grants: ["principal_id", "scope_id"],
  acl_grants: ["owner_scope_id", "grantee_scope_id"],
  persona_access: ["grantee_scope_id"],
  team_members: ["principal_id"],
  team_rooms: ["scope_id"],
  memory_facts: ["scope_id"],
  file_artifacts: ["owner_scope_id", "created_in_scope"],
  environment_attachments: ["scope_id"],
  process_sessions: ["scope_id", "session_ref"],
  budget_spend: ["principal_id"],
};

const TEXT_DOCUMENTS: Record<string, readonly string[]> = {
  sessions: ["spawn_meta"],
  runs: ["request"],
};

const JSON_DOCUMENTS: Record<string, readonly string[]> = {
  sessions: ["slack_binding"],
  run_signals: ["payload"],
  deliveries: ["destination", "provenance"],
  channel_state: ["source"],
};

const DURABLE_MAPS = [
  "approvals",
  "approval_grants",
  "approval_grant_modes",
  "ambient_cursors",
  "browser_sessions",
  "consent_links",
  "context_requests",
  "crons",
  "deactivated_principals",
  "external_members",
  "idempotency",
  "keychain_asks",
  "keychain_credentials",
  "keychain_grants",
  "loop_ingress",
  "loop_ingress_deliveries",
  "loop_items",
  "loop_outputs",
  "loop_ship_grants",
  "loops",
  "memory_registry",
  "monitors",
  "oauth_flows",
  "projects",
  "sandbox_defaults",
  "sandbox_loads",
  "sandbox_resources",
  "secret_drops",
  "session_mailbox",
  "session_shares",
  "swarms",
  "web_ui_state",
  "webhooks",
];

const identifier = (column: string) =>
  `CASE WHEN ${column} = '${RETIRED}' THEN '${GENERIC_CHAT}' ELSE replace(${column}, '${RETIRED}:', '${GENERIC_CHAT}:') END`;
const document = (column: string) =>
  `replace(replace(${column}::text, '"${RETIRED}"', '"${GENERIC_CHAT}"'), '${RETIRED}:', '${GENERIC_CHAT}:')`;

function rewrites(): Map<string, [column: string, value: string][]> {
  const sets = new Map<string, [string, string][]>();
  const add = (table: string, column: string, value: string) =>
    sets.set(table, [...(sets.get(table) ?? []), [column, value]]);
  for (const [table, columns] of Object.entries(IDENTIFIERS))
    for (const column of columns) add(table, column, identifier(column));
  for (const [table, columns] of Object.entries(TEXT_DOCUMENTS))
    for (const column of columns) add(table, column, document(column));
  for (const [table, columns] of Object.entries(JSON_DOCUMENTS))
    for (const column of columns) add(table, column, `${document(column)}::jsonb`);
  for (const table of DURABLE_MAPS) {
    add(table, "id", identifier("id"));
    add(table, "json", `${document("json")}::jsonb`);
  }
  return sets;
}

function rewriteStatement(table: string, sets: readonly [string, string][]): string {
  const retired = sets.map(([column]) => `${column}::text LIKE '%${RETIRED}%'`).join(" OR ");
  return `IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('${table}') AND attname = 'tenant_id' AND NOT attisdropped) THEN
         FOR tenant IN SELECT DISTINCT tenant_id FROM ${table} WHERE ${retired} LOOP
           PERFORM set_config('qm.tenant_id', tenant::text, true);
           UPDATE ${table} SET ${sets.map(([column, value]) => `${column} = ${value}`).join(", ")}
            WHERE tenant_id = tenant AND (${retired});
         END LOOP;
       END IF;`;
}

export const GENERIC_CHAT_RENAME: PgMigrationDefinition = {
  id: "surfaces/0006-generic-chat-rename",
  statements: [
    `SET LOCAL check_function_bodies = off`,
    `UPDATE tenants SET settings = settings - 'partnerChatAccount'
       || jsonb_build_object('genericChatAccount', settings->'partnerChatAccount')
      WHERE settings ? 'partnerChatAccount'`,
    `DROP INDEX IF EXISTS tenants_partner_chat_account`,
    `DROP FUNCTION IF EXISTS qm_tenant_for_partner_chat(text)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS tenants_generic_chat_account ON tenants ((settings->>'genericChatAccount'))`,
    tenantKeyFunction(
      "qm_tenant_for_generic_chat",
      "uuid",
      `SELECT id FROM tenants WHERE settings->>'genericChatAccount' = $1${servingTenant("id")}`,
    ),
    `DO $rename$ DECLARE tenant uuid; BEGIN
       ${[...rewrites()].map(([table, sets]) => rewriteStatement(table, sets)).join("\n       ")}
       PERFORM set_config('qm.tenant_id', '', true);
     END $rename$`,
  ],
};
