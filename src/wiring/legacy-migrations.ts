import type { StoresModule } from "./stores.ts";
import { LOOPS_TO_CRONS_MIGRATION } from "../cron/migrations.ts";
import { INBOX_ITEM_SOURCE_MIGRATION, inboxConversationKeyMigration } from "../inbox/ledger.ts";
import { CONTRACT_MIGRATIONS } from "../persistence/contract-migrations.ts";

type UpgradeMigrationsInputs = { stores: StoresModule };

export function registerLegacyMigrations(deps: UpgradeMigrationsInputs) {
  const { pgPool } = deps.stores;

  pgPool.registerMigration(LOOPS_TO_CRONS_MIGRATION);
  pgPool.registerMigration(INBOX_ITEM_SOURCE_MIGRATION);
  pgPool.registerMigration(inboxConversationKeyMigration());
  pgPool.registerMigration({
    id: "runtime/0002-drop-harness-choice",
    acceptedChecksums: ["2e7a8523090c84d00b557197f2e3038b5b2fd418e6b3b4b08c10ef0cf596a792"],
    statements: [
      `DO $$ BEGIN IF to_regclass('base_model_configs') IS NOT NULL THEN UPDATE base_model_configs SET json = (CASE WHEN json ? 'harnessId' AND NOT json ? 'orgRevision' THEN json || '{"orgRevision":0}'::jsonb ELSE json END) - 'harnessId' #- '{cronRuntime,harnessId}' #- '{subagentRuntime,harnessId}' #- '{fallbackRuntime,harnessId}' WHERE json ? 'harnessId' OR (json -> 'cronRuntime') ? 'harnessId' OR (json -> 'subagentRuntime') ? 'harnessId' OR (json -> 'fallbackRuntime') ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('auto_flagger_configs') IS NOT NULL THEN UPDATE auto_flagger_configs SET json = json - 'harnessId' WHERE json ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('crons') IS NOT NULL THEN UPDATE crons SET json = json #- '{runtime,harnessId}' WHERE (json -> 'runtime') ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('swarms') IS NOT NULL THEN UPDATE swarms SET json = json #- '{template,harness}' WHERE (json -> 'template') ? 'harness'; END IF; END $$`,
    ],
  });
  pgPool.registerMigration({
    id: "runtime/0003-promote-legacy-base-models",
    statements: [
      `DO $$ BEGIN IF to_regclass('base_model_configs') IS NOT NULL THEN UPDATE base_model_configs SET json = json || '{"orgRevision":0}'::jsonb WHERE json ? 'modelId' AND NOT json ? 'orgRevision'; END IF; END $$`,
    ],
  });
  pgPool.registerMigration({
    id: "durable-map/swarms/0002-drop",
    acceptedChecksums: ["6fd03996fb6c9b0b5ea06db198f83a16cf39dafbf7bc9fddb8965e54b3030635"],
    statements: [
      `DO $$ BEGIN IF to_regclass('runs') IS NOT NULL THEN UPDATE runs SET status = 'failed', result = json_build_object('status', 'failed', 'sessionId', session_id, 'reason', 'swarms were removed')::text, lease_token = NULL, lease_expires_at = NULL, worker_id = NULL, finished_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint WHERE status IN ('pending', 'running') AND (session_id LIKE 'swarm:%' OR request LIKE '%"swarm":%'); END IF; END $$`,
      "DO $$ BEGIN IF to_regclass('feature_flags') IS NOT NULL THEN DELETE FROM feature_flags WHERE id = 'swarms'; END IF; END $$",
    ],
  });
  for (const migration of CONTRACT_MIGRATIONS) pgPool.registerMigration(migration);
}
