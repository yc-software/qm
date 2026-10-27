import { pgMigrationFrom, type PgMigration, type PgMigrationDefinition } from "./pg-pool.ts";

export const CONTRACT_MIGRATIONS: readonly PgMigrationDefinition[] = [
  { id: "contract/0001-drop-deliveries", statements: ["DROP TABLE IF EXISTS deliveries"] },
  { id: "contract/0002-drop-model-registry", statements: ["DROP TABLE IF EXISTS model_registry"] },
  { id: "contract/0003-drop-approved-harness-configs", statements: ["DROP TABLE IF EXISTS approved_harness_configs"] },
  { id: "contract/0004-drop-swarms", statements: ["DROP TABLE IF EXISTS swarms"] },
  {
    id: "contract/0005-drop-spend-json-indexes",
    statements: [
      "SET LOCAL lock_timeout = '3s'",
      "DROP INDEX IF EXISTS session_llm_requests_spend",
      "DROP INDEX IF EXISTS session_llm_requests_spend_wide",
    ],
  },
  {
    id: "contract/0006-drop-channel-policy-orders",
    statements: [
      "SET LOCAL lock_timeout = '3s'",
      "ALTER TABLE channel_policy DROP COLUMN IF EXISTS orders",
      "ALTER TABLE channel_policy_history DROP COLUMN IF EXISTS orders",
    ],
  },
  {
    id: "contract/0007-drop-durable-map-versions",
    statements: ["DROP FUNCTION IF EXISTS qm_durable_map_bump() CASCADE", "DROP TABLE IF EXISTS durable_map_versions"],
  },
  {
    id: "contract/0008-drop-sandbox-routing",
    statements: ["DROP TABLE IF EXISTS sandbox_routing", "DROP TABLE IF EXISTS sandbox_resource_rollout"],
  },
  {
    id: "contract/0009-drop-runs-engine",
    statements: ["SET LOCAL lock_timeout = '3s'", "ALTER TABLE runs DROP COLUMN IF EXISTS engine"],
  },
  {
    id: "contract/0010-drop-retired-schema",
    statements: [
      "SET LOCAL lock_timeout = '3s'",
      "DROP TABLE IF EXISTS loop_ingress",
      "DROP TABLE IF EXISTS loop_ingress_deliveries",
      "DROP TABLE IF EXISTS loop_outputs",
      "DROP TABLE IF EXISTS loop_ship_grants",
      "DROP TABLE IF EXISTS people_directory_urls",
      "DROP TABLE IF EXISTS aws_sandbox_bodies",
      "DROP TABLE IF EXISTS sharing_postures",
      "DROP TABLE IF EXISTS superserve_config_epochs",
      "DROP TABLE IF EXISTS superserve_sandbox_bodies",
      "DROP INDEX IF EXISTS loop_items_loopid_fold",
      "DROP INDEX IF EXISTS loop_items_loopid_unicode",
      "DROP STATISTICS IF EXISTS loop_items_loopid_stats",
      "DROP INDEX IF EXISTS idx_runs_fair_key",
      "ALTER TABLE runs DROP COLUMN IF EXISTS fair_key",
    ],
  },
];

export const HELD_BACK_CONTRACT_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "contract/0011-drop-tenant-env-bags",
    statements: ["ALTER TABLE IF EXISTS tenants DROP COLUMN IF EXISTS env, DROP COLUMN IF EXISTS secret_env"],
  },
];

export const pgMigrationsFrom = (definition: PgMigrationDefinition): PgMigration[] =>
  [...(definition.before ?? []), definition, ...(definition.contract ? [definition.contract] : [])].map(
    pgMigrationFrom,
  );

const migrationPhase = (id: string): number => (id.startsWith("contract/") ? 1 : 0);

export const pgMigrationOrder = (a: string, b: string): number =>
  migrationPhase(a) - migrationPhase(b) || a.localeCompare(b);
