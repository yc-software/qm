import type { PoolClient } from "../persistence/pg-pool.ts";
import { CONFIG_TABLES } from "../resolution/config-tables.ts";
import { foldPrincipalId } from "../directory/person.ts";
import { personalScope } from "../types.ts";

interface Rewrite {
  table: string;
  column: string;
  scope: boolean;
  field?: string;
  key?: readonly string[];
  managedCron?: boolean;
}

const principal = (table: string, column: string, opts: Partial<Rewrite> = {}): Rewrite => ({
  table,
  column,
  scope: false,
  ...opts,
});
const scope = (table: string, column: string, opts: Partial<Rewrite> = {}): Rewrite => ({
  table,
  column,
  scope: true,
  ...opts,
});
const UNIQUE = { key: [] };

const TRIGGER_TABLES = ["crons", "monitors", "webhooks"];

const PRINCIPAL_REWRITES: readonly Rewrite[] = [
  principal("participants", "principal_id", { key: ["session_id"] }),
  scope("sessions", "scope_id"),
  scope("memory_facts", "scope_id"),
  scope("memory_fact_vectors", "scope_id", { key: ["model", "fact_id"] }),
  scope("memory_capture_pending", "scope_id"),
  scope("memory_capture_pending", "conversation_scope_id"),
  principal("memory_capture_pending", "actor_id"),
  scope("memory_tidy_profiles", "id", { ...UNIQUE, managedCron: true }),
  principal("suggested_activity_profiles", "id", { ...UNIQUE, managedCron: true }),
  ...TRIGGER_TABLES.flatMap((table) => [
    principal(table, "owner"),
    scope(table, "owner_scope_id"),
    principal(table, "created_by"),
    scope(table, "destination", { field: "audienceScopeId" }),
  ]),
  scope("deployments", "owner_scope_id"),
  scope("deployments", "created_in_scope"),
  principal("deployments", "created_by"),
  scope("file_artifacts", "owner_scope_id"),
  scope("file_artifacts", "created_in_scope"),
  principal("file_artifacts", "created_by"),
  scope("acl_grants", "owner_scope_id", { key: ["path", "grantee_scope_id", "permission"] }),
  scope("acl_grants", "grantee_scope_id", { key: ["owner_scope_id", "path", "permission"] }),
  scope("skills", "scope_id"),
  principal("skills", "created_by"),
  scope("skill_packs", "target_scope_id"),
  principal("skill_packs", "created_by"),
  principal("browser_sessions", "principal_id", UNIQUE),
  principal("environments", "owner_actor_id"),
  scope("environment_attachments", "scope_id", UNIQUE),
  scope("sandbox_resources", "owner_scope_id"),
  principal("sandbox_resources", "created_by"),
  scope("sandbox_defaults", "scope_id", UNIQUE),
  ...Object.values(CONFIG_TABLES)
    .filter((spec) => spec.key === "scopeId")
    .map((spec) => scope(spec.table, "scope_id", UNIQUE)),
];

function statements(r: Rewrite): string[] {
  const current = r.field ? `moved.${r.column}->>'${r.field}'` : `moved.${r.column}`;
  const assign = r.field
    ? `${r.column} = jsonb_set(moved.${r.column}, '{${r.field}}', to_jsonb($2::text))`
    : `${r.column} = $2::text`;
  const rewrite = `UPDATE ${r.table} AS moved SET ${assign} WHERE ${current} = $1::text`;
  if (!r.key) return [rewrite];
  const same = r.key.map((k) => ` AND kept.${k} IS NOT DISTINCT FROM moved.${k}`).join("");
  const duplicate = `moved.${r.column} = $1::text AND EXISTS (SELECT 1 FROM ${r.table} kept WHERE kept.${r.column} = $2::text${same})`;
  return [
    ...(r.managedCron
      ? [`DELETE FROM crons WHERE id IN (SELECT moved.cron_id FROM ${r.table} moved WHERE ${duplicate})`]
      : []),
    `DELETE FROM ${r.table} AS moved WHERE ${duplicate}`,
    rewrite,
  ];
}

export async function mergePrincipalData(client: PoolClient, aliasId: string, canonicalId: string): Promise<void> {
  const { rows } = await client.query<{ name: string }>(
    "SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema = current_schema()",
  );
  const present = new Set(rows.map((row) => row.name));
  const rewrites = PRINCIPAL_REWRITES.filter((r) =>
    [r.column, ...(r.key ?? []), ...(r.managedCron ? ["cron_id"] : [])].every((column) =>
      present.has(`${r.table}.${column}`),
    ),
  );
  for (const spelling of new Set([aliasId, foldPrincipalId(aliasId)]))
    for (const r of rewrites) {
      const params = r.scope ? [personalScope(spelling), personalScope(canonicalId)] : [spelling, canonicalId];
      for (const sql of statements(r)) await client.query(sql, params);
    }
}
