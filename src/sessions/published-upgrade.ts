import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { msOf, USER_KINDS } from "./items.ts";
import { ITEMS_CUTOVER_MIGRATIONS } from "./legacy-history-migrations.ts";

const stableOriginPattern = (origin: string): string => `^agent:main:${origin}:[^:]+$`;
const legacyOriginPattern = (origin: string): string => `^${origin}:[^:]+(:.+)?$`;
const ORIGIN_ALTERNATION = "(cron|webhook|monitor|loop|swarm)";
const STABLE_CRON_ID_PATTERN = "^agent:main:cron:([^:]+)$";
const LEGACY_CRON_ID_PATTERN = "^cron:([^:]+)(:.+)?$";
const threadRefCronIdExpr = (threadRef: string): string =>
  `COALESCE(substring(${threadRef} FROM '${STABLE_CRON_ID_PATTERN}'), substring(${threadRef} FROM '${LEGACY_CRON_ID_PATTERN}'))`;

const threadRefOriginExpr = (threadRef: string): string =>
  `COALESCE(substring(${threadRef} FROM '${stableOriginPattern(ORIGIN_ALTERNATION)}'), substring(${threadRef} FROM '${legacyOriginPattern(ORIGIN_ALTERNATION)}'), 'conversation')`;

const LOOP_OR_SWARM_REF = legacyOriginPattern("(loop|swarm)");

const sessionOriginBackfillLoop = (candidates: string, keepSpendMarkers: boolean): string => `
  after := '';
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch
      FROM (SELECT id FROM sessions WHERE id > after AND ${candidates} ORDER BY id LIMIT 5000) candidates;
    EXIT WHEN batch IS NULL;
    UPDATE sessions SET origin = ${threadRefOriginExpr("thread_ref")}, origin_id = ${threadRefCronIdExpr("thread_ref")}
     WHERE id = ANY(batch);${keepSpendMarkers ? "" : "\n    DELETE FROM session_spend_dirty WHERE writer = pg_current_xact_id();"}
    after := batch[cardinality(batch)];
    COMMIT;
    PERFORM pg_sleep(0.25);
  END LOOP;`;

const SESSION_ORIGIN_BACKFILL_SQL = `DO $session_origin_backfill$
DECLARE
  batch text[];
  after text;
BEGIN${sessionOriginBackfillLoop(`origin IS NULL AND thread_ref !~ '${LOOP_OR_SWARM_REF}'`, false)}${sessionOriginBackfillLoop(
  `(origin IS NULL OR origin = 'conversation') AND thread_ref ~ '${LOOP_OR_SWARM_REF}'`,
  true,
)}
END $session_origin_backfill$`;

const LAST_USER_ACTIVITY_BACKFILL_SQL = `DO $last_user_activity_backfill$
DECLARE
  batch text[];
  after text := '';
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch
      FROM (SELECT id FROM sessions WHERE id > after ORDER BY id LIMIT 2000) candidates;
    EXIT WHEN batch IS NULL;
    WITH latest AS MATERIALIZED (
      SELECT b.id, (SELECT ${msOf("MAX(e.created_at)")} FROM items e
                     WHERE e.tenant_id = qm_tenant_id() AND e.session_id = b.id AND e.kind IN ${USER_KINDS}) AS at
        FROM unnest(batch) AS b(id))
    UPDATE sessions s
       SET last_user_activity = latest.at
      FROM latest
     WHERE s.id = latest.id AND latest.at IS NOT NULL
       AND (s.last_user_activity IS NULL OR s.last_user_activity < latest.at);
    after := batch[cardinality(batch)];
    COMMIT;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $last_user_activity_backfill$`;

const migrations: readonly PgMigrationDefinition[] = [
  {
    id: "sessions/store/0034-session-origin-backfill",
    prepare: [SESSION_ORIGIN_BACKFILL_SQL],
    statements: [],
  },
  ...ITEMS_CUTOVER_MIGRATIONS,
  {
    id: "sessions/store/0037-drop-legacy-history",
    statements: [
      `SET LOCAL lock_timeout = '60s'`,
      `DROP TRIGGER IF EXISTS session_entry_search ON items`,
      `DROP FUNCTION IF EXISTS sync_item_search(), sync_session_entry_search()`,
      `DROP VIEW IF EXISTS session_transcript_entries`,
      `DROP TABLE IF EXISTS session_entry_search, legacy_session_entries, session_entries, session_tape,
             legacy_tape_steps, legacy_turn_runs, legacy_tape_steps_progress, legacy_tape_skipped,
             legacy_tape_writes, legacy_prep_runs`,
      `DROP PROCEDURE IF EXISTS prepare_legacy_tape_steps(INT)`,
      `DROP FUNCTION IF EXISTS legacy_tape_written(), legacy_tape_steps_batch(TEXT[], BIGINT),
             entry_search_text(text), items_copy_payload(text), items_copy_payload(jsonb)`,
      `DROP SCHEMA IF EXISTS items_copy_ops CASCADE`,
    ],
  },
  {
    id: "sessions/store/0038-scoped-origin-pages",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_conversations_by_scope_activity
        ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC) WHERE origin = 'conversation'`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_other_background_by_scope_activity
        ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC) WHERE origin NOT IN ('conversation', 'cron')`,
    ],
  },
  {
    id: "sessions/store/0039-items-call-id-digest-index",
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS items_one_call_per_kind_digest
        ON items(tenant_id, session_id, kind, md5(call_id)) WHERE call_id IS NOT NULL`,
    ],
  },
  {
    id: "sessions/store/0040-items-call-id-digest-swap",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `DROP INDEX IF EXISTS items_one_call_per_kind`,
      `ALTER INDEX items_one_call_per_kind_digest RENAME TO items_one_call_per_kind`,
    ],
  },
  {
    id: "sessions/store/0041-drop-inline-llm-request",
    statements: [`SET LOCAL lock_timeout = '15s'`, `ALTER TABLE session_llm_requests DROP COLUMN IF EXISTS request`],
  },
  {
    id: "sessions/store/0042-llm-prompt-envelopes-created-at",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS llm_prompt_envelopes_created_at
             ON llm_prompt_envelopes(created_at)`,
    ],
  },
  {
    id: "sessions/store/0043-last-user-activity",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_user_activity BIGINT`,
    ],
  },
  {
    id: "sessions/store/0044-last-user-activity-backfill",
    prepare: [LAST_USER_ACTIVITY_BACKFILL_SQL],
    statements: [],
  },
  {
    id: "sessions/store/0045-side-chats",
    statements: [
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS side_chat JSONB`,
      `CREATE INDEX IF NOT EXISTS sessions_side_chat_origin ON sessions (forked_from_session_id) WHERE side_chat IS NOT NULL`,
    ],
  },
  {
    id: "sessions/store/0046-spend-days-cron-rebuild",
    statements: [`INSERT INTO session_spend_dirty(day) SELECT day FROM session_spend_days ON CONFLICT DO NOTHING`],
  },
];

const RELEASE_TENANT_SEED: PgMigrationDefinition = {
  id: "sessions/store/0034-tenant-seed",
  statements: [
    `DO $release_tenant_seed$
     DECLARE
       boot uuid;
     BEGIN
       IF to_regclass('qm_tenant') IS NOT NULL OR to_regclass('items') IS NOT NULL
          OR to_regprocedure('qm_boot_tenant()') IS NULL THEN
         RETURN;
       END IF;
       EXECUTE 'SELECT qm_boot_tenant()' INTO boot;
       IF boot IS NOT NULL THEN
         CREATE TABLE qm_tenant(id UUID PRIMARY KEY);
         CREATE UNIQUE INDEX qm_tenant_singleton ON qm_tenant((true));
         INSERT INTO qm_tenant(id) VALUES (boot);
       END IF;
     END $release_tenant_seed$`,
  ],
};

export const PUBLISHED_SESSION_UPGRADE = [...migrations, RELEASE_TENANT_SEED].map((migration) => ({
  ...migration,
  upgradeFrom: "sessions/store/0033-client-tools",
}));
