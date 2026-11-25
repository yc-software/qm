import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { authoredUserTurn } from "./items.ts";
import { TENANCY, tenantRowSecurity, tenantTables } from "../tenants/migrations.ts";
import { DROP_TENANT_PREBUILD_INDEXES } from "../tenants/prebuilt-indexes.ts";
import { claimFunction } from "../tenants/claim.ts";

export const SPEND_INDEXABLE = `(spend_usage_json(usage_json) IS NOT NULL
  AND octet_length(session_id) + octet_length(model) + octet_length(usage_json) <= 2000)`;

const PREVIOUS_SCHEMA = "sessions/store/0046-spend-days-cron-rebuild";

const SESSION_SCHEMA: PgMigrationDefinition = {
  id: "sessions/store/0047-base-schema",
  expectedChecksum: "09cc3da1e893709927f3a18d593d543289d9d92dc416c56f426e3a5d69957099",
  statements: [
    `DO $base_schema$
BEGIN
  IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = '${PREVIOUS_SCHEMA}') THEN
    RETURN;
  END IF;
  IF to_regclass('sessions') IS NOT NULL THEN
    RAISE EXCEPTION 'This database has session tables from a release older than ${PREVIOUS_SCHEMA}. Start a release that applies ${PREVIOUS_SCHEMA} but predates the base schema, then upgrade.';
  END IF;

  CREATE EXTENSION IF NOT EXISTS btree_gin;

  CREATE FUNCTION spend_usage_json(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $spend_usage_json$
             DECLARE j jsonb;
             BEGIN
               IF t IS NULL OR octet_length(t) > 2000 OR NOT pg_input_is_valid(t, 'jsonb') THEN
                 RETURN NULL;
               END IF;
               j := t::jsonb;
               IF pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN
                 RETURN j;
               END IF;
               RETURN NULL;
             END
             $spend_usage_json$;

  CREATE TABLE sessions(
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    thread_ref TEXT UNIQUE NOT NULL,
    created_at BIGINT NOT NULL,
    title TEXT,
    channel_name TEXT,
    surface TEXT,
    last_activity BIGINT,
    messages INT,
    turns INT,
    forked_from_session_id TEXT,
    forked_from_title TEXT,
    fork_boundary_seq INT,
    origin TEXT,
    origin_id TEXT,
    parent_session_id TEXT,
    spawn_meta TEXT,
    first_user_preview TEXT,
    last_user_preview TEXT,
    client_tools JSONB,
    last_user_activity BIGINT,
    side_chat JSONB,
    CONSTRAINT sessions_fork_provenance_pair CHECK ((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL))
  ) WITH (fillfactor = 70);
  CREATE INDEX sessions_by_scope ON sessions(scope_id, created_at DESC);
  CREATE INDEX sessions_by_activity ON sessions((COALESCE(last_activity, created_at)) DESC, id DESC);
  CREATE INDEX sessions_by_scope_activity ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC);
  CREATE INDEX sessions_conversations_by_scope_activity
    ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC) WHERE origin = 'conversation';
  CREATE INDEX sessions_other_background_by_scope_activity
    ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC) WHERE origin NOT IN ('conversation', 'cron');
  CREATE INDEX idx_sessions_parent_session_id ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;
  CREATE INDEX sessions_side_chat_origin ON sessions(forked_from_session_id) WHERE side_chat IS NOT NULL;

  CREATE TABLE participants(
    session_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    valid_from BIGINT NOT NULL,
    valid_to BIGINT,
    valid_from_seq INT,
    valid_to_seq INT,
    title TEXT,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    color TEXT,
    read_at BIGINT,
    PRIMARY KEY (session_id, principal_id)
  );
  CREATE INDEX participants_by_principal ON participants(principal_id, session_id);

  CREATE TABLE session_leases(
    session_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    holder TEXT,
    acquired_at BIGINT
  );

  CREATE TABLE session_llm_requests(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_seq INT,
    step INT NOT NULL,
    model TEXT NOT NULL,
    scope_label TEXT NOT NULL,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    ttft_ms INT,
    duration_ms INT,
    step_gap_ms INT,
    tool_wall_json TEXT,
    usage_json TEXT,
    transport_json TEXT,
    gap_phases_json TEXT,
    prompt_hash TEXT
  );
  CREATE INDEX session_llm_requests_by_session ON session_llm_requests(session_id, created_at, step);
  CREATE INDEX session_llm_requests_created_at ON session_llm_requests(created_at);
  CREATE INDEX session_llm_requests_screens ON session_llm_requests(created_at DESC) WHERE step = -1;
  CREATE INDEX session_llm_requests_spend
    ON session_llm_requests(created_at,
      ((spend_usage_json(usage_json) ->> 'costUsd')::double precision),
      ((spend_usage_json(usage_json) ->> 'input')::bigint),
      ((spend_usage_json(usage_json) ->> 'output')::bigint),
      ((spend_usage_json(usage_json) ->> 'cacheRead')::bigint),
      ((spend_usage_json(usage_json) ->> 'cacheWrite')::bigint))
    INCLUDE (session_id, model, usage_json)
    WHERE usage_json IS NOT NULL AND ${SPEND_INDEXABLE};
  CREATE INDEX session_llm_requests_spend_wide
    ON session_llm_requests(created_at) WHERE usage_json IS NOT NULL AND NOT ${SPEND_INDEXABLE};

  CREATE TABLE llm_prompt_envelopes(hash TEXT PRIMARY KEY, body TEXT NOT NULL, created_at BIGINT NOT NULL);
  CREATE INDEX llm_prompt_envelopes_created_at ON llm_prompt_envelopes(created_at);

  CREATE TABLE session_pins(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    text TEXT,
    entry_seq INT,
    added_by TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX session_pins_by_session ON session_pins(session_id, created_at);

  CREATE TABLE session_goals(
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'complete', 'cancelled')),
    floor JSONB,
    token_cap BIGINT,
    tokens_used BIGINT NOT NULL DEFAULT 0,
    active_ms BIGINT,
    active_since TIMESTAMPTZ,
    completion_note TEXT,
    cancel_note TEXT,
    governor JSONB,
    pause_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE session_spend_days(day BIGINT PRIMARY KEY, rows JSONB NOT NULL, updated_at BIGINT NOT NULL);
  CREATE TABLE session_spend_dirty(
    day BIGINT,
    session_id TEXT,
    writer xid8 NOT NULL DEFAULT pg_current_xact_id(),
    UNIQUE (day, writer),
    CHECK (num_nonnulls(day, session_id) = 1)
  );
  CREATE FUNCTION invalidate_request_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_request_spend$
           BEGIN
             INSERT INTO session_spend_dirty(day)
             SELECT DISTINCT floor(at::numeric / 86400000)::bigint
               FROM (VALUES
                 (CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.created_at END),
                 (CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.created_at END)
               ) changed(at) WHERE at IS NOT NULL
             ON CONFLICT DO NOTHING;
             RETURN NULL;
           END $invalidate_request_spend$;
  CREATE TRIGGER session_llm_requests_spend_dirty
    AFTER INSERT OR UPDATE OF created_at, session_id, model, usage_json OR DELETE ON session_llm_requests
    FOR EACH ROW EXECUTE FUNCTION invalidate_request_spend();
  CREATE FUNCTION invalidate_session_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_session_spend$
           BEGIN
             IF TG_OP = 'UPDATE' AND ROW(OLD.id, OLD.scope_id, OLD.origin, OLD.thread_ref, OLD.parent_session_id)
                  IS NOT DISTINCT FROM ROW(NEW.id, NEW.scope_id, NEW.origin, NEW.thread_ref, NEW.parent_session_id) THEN
               RETURN NULL;
             END IF;
             INSERT INTO session_spend_dirty(session_id)
             SELECT DISTINCT id FROM (VALUES (OLD.id), (NEW.id)) changed(id) WHERE id IS NOT NULL;
             RETURN NULL;
           END $invalidate_session_spend$;
  CREATE TRIGGER sessions_spend_dirty
    AFTER INSERT OR UPDATE OF id, scope_id, origin, thread_ref, parent_session_id OR DELETE ON sessions
    FOR EACH ROW EXECUTE FUNCTION invalidate_session_spend();

  CREATE TABLE qm_tenant(id UUID PRIMARY KEY);
  CREATE UNIQUE INDEX qm_tenant_singleton ON qm_tenant((true));
  INSERT INTO qm_tenant(id) VALUES (gen_random_uuid());
  CREATE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
    AS $qm_tenant_id$ SELECT id FROM qm_tenant $qm_tenant_id$;

  CREATE TABLE qm_settings(key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

  CREATE TYPE item_kind AS ENUM ('UserMessage', 'SteeringMessage', 'AgentMessage', 'Reasoning', 'ToolCall', 'ToolResult',
    'Elicitation', 'ElicitationResponse', 'Wake', 'Error', 'ContextCompaction', 'Retraction', 'Stop', 'RuntimeChange');
  CREATE TYPE wake_cause AS ENUM ('cron', 'webhook', 'child_done', 'system');

  CREATE TABLE blobs(
    tenant_id UUID NOT NULL,
    sha256 BYTEA NOT NULL CHECK (length(sha256) = 32),
    size BIGINT NOT NULL CHECK (size >= 0),
    mime TEXT,
    storage_key TEXT NOT NULL CHECK (storage_key <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, sha256)
  );

  CREATE TABLE items(
    tenant_id UUID NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL CHECK (seq >= 0),
    turn_id UUID,
    kind item_kind NOT NULL,
    author TEXT CHECK (author <> ''),
    call_id TEXT CHECK (call_id <> ''),
    elicit_id TEXT CHECK (elicit_id <> ''),
    wake_cause wake_cause,
    error_code TEXT CHECK (error_code <> ''),
    text TEXT CHECK (text <> ''),
    tool TEXT CHECK (tool <> ''),
    step INT CHECK (step >= 0),
    variant TEXT CHECK (variant IN ('narration', 'files_delivered')),
    is_error BOOLEAN,
    hidden BOOLEAN,
    external_id TEXT CHECK (external_id <> ''),
    through_seq BIGINT,
    approved BOOLEAN,
    blob_sha BYTEA,
    search TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED,
    body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object'),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, session_id, seq),
    CONSTRAINT items_call_id_kind CHECK (call_id IS NULL OR kind IN ('ToolCall', 'ToolResult')),
    CONSTRAINT items_elicit_id_kind CHECK ((elicit_id IS NOT NULL) = (kind IN ('Elicitation', 'ElicitationResponse'))),
    CONSTRAINT items_wake_cause_kind CHECK ((wake_cause IS NOT NULL) = (kind = 'Wake')),
    CONSTRAINT items_error_code_kind CHECK ((error_code IS NOT NULL) = (kind = 'Error')),
    CONSTRAINT items_author_kind CHECK (author IS NULL OR kind IN ('UserMessage', 'SteeringMessage', 'ElicitationResponse', 'Stop', 'RuntimeChange')),
    CONSTRAINT items_text_kind CHECK (text IS NULL OR kind IN ('UserMessage', 'SteeringMessage', 'AgentMessage', 'Reasoning', 'ToolResult', 'Error', 'ContextCompaction')),
    CONSTRAINT items_tool_kind CHECK (tool IS NULL OR kind IN ('ToolCall', 'ToolResult')),
    CONSTRAINT items_step_kind CHECK (step IS NULL OR kind IN ('ToolCall', 'ToolResult', 'Reasoning', 'AgentMessage')),
    CONSTRAINT items_variant_kind CHECK (variant IS NULL OR kind IN ('AgentMessage')),
    CONSTRAINT items_is_error_kind CHECK (is_error IS NULL OR kind IN ('ToolResult')),
    CONSTRAINT items_hidden_kind CHECK (hidden IS NULL OR kind IN ('UserMessage')),
    CONSTRAINT items_external_id_kind CHECK (external_id IS NULL OR kind IN ('UserMessage')),
    CONSTRAINT items_through_seq_kind CHECK (through_seq IS NULL OR kind IN ('ContextCompaction')),
    CONSTRAINT items_approved_kind CHECK (approved IS NULL OR kind IN ('ElicitationResponse')),
    CONSTRAINT items_blob_sha_kind CHECK (blob_sha IS NULL OR kind IN ('ToolResult')),
    CONSTRAINT items_blob FOREIGN KEY (tenant_id, blob_sha) REFERENCES blobs(tenant_id, sha256)
  );
  CREATE UNIQUE INDEX items_one_call_per_kind ON items(tenant_id, session_id, kind, md5(call_id)) WHERE call_id IS NOT NULL;
  CREATE INDEX items_by_turn ON items(tenant_id, turn_id, seq) WHERE turn_id IS NOT NULL;
  CREATE INDEX items_by_elicit ON items(tenant_id, session_id, elicit_id) WHERE elicit_id IS NOT NULL;
  CREATE INDEX items_by_external_id ON items(tenant_id, session_id, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX items_session_kind_created ON items(tenant_id, session_id, kind, created_at);
  CREATE INDEX items_search ON items USING gin (tenant_id, session_id, search);

  CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $forbid_mutation$
   BEGIN
     RAISE EXCEPTION '% on % is forbidden', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
   END $forbid_mutation$;
  CREATE FUNCTION forbid_direct_delete() RETURNS trigger LANGUAGE plpgsql AS $forbid_direct_delete$
   BEGIN
     IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
     RAISE EXCEPTION 'DELETE on % is only allowed through its session', TG_TABLE_NAME
       USING ERRCODE = 'integrity_constraint_violation';
   END $forbid_direct_delete$;
  CREATE TRIGGER items_append_only BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  CREATE TRIGGER items_no_truncate BEFORE TRUNCATE ON items FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
  CREATE TRIGGER items_delete_through_session BEFORE DELETE ON items FOR EACH ROW EXECUTE FUNCTION forbid_direct_delete();
  CREATE TRIGGER blobs_immutable BEFORE UPDATE OR DELETE ON blobs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  CREATE TRIGGER blobs_no_truncate BEFORE TRUNCATE ON blobs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
END $base_schema$`,
    `DROP FUNCTION IF EXISTS safe_json(text)`,
  ],
};

const MESSAGE_SEARCH_INDEX: PgMigrationDefinition = {
  id: "sessions/store/0048-message-search-index",
  statements: [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS items_message_search ON items USING gin (tenant_id, search)
      WHERE kind IN ('UserMessage','SteeringMessage','AgentMessage') AND variant IS DISTINCT FROM 'files_delivered' AND text IS NOT NULL`,
  ],
};

const DROP_ITEMS_SEARCH: PgMigrationDefinition = {
  id: "sessions/store/0049-drop-items-search",
  statements: [`SET LOCAL lock_timeout = '5s'`, `DROP INDEX IF EXISTS items_search`],
};

export const TENANT_BACKFILL: PgMigrationDefinition = {
  id: "sessions/store/0050-tenant-backfill",
  statements: [
    `INSERT INTO tenants(id)
     SELECT id FROM qm_tenant
     ON CONFLICT (id) DO NOTHING`,
  ],
};

const SPEND_RECOVERY_INDEX: PgMigrationDefinition = {
  id: "sessions/store/0051-spend-recovery-index",
  statements: [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_llm_requests_session_spend_recovery
      ON session_llm_requests(session_id, created_at) WHERE usage_json IS NOT NULL`,
  ],
};

const SESSION_FACTS: PgMigrationDefinition = {
  id: "sessions/store/0052-session-facts",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS slack_binding JSONB, ADD COLUMN IF NOT EXISTS runtime JSONB`,
  ],
};

const PARTICIPANT_MEMBERSHIP: PgMigrationDefinition = {
  id: "sessions/store/0055-participant-membership",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE participants ALTER COLUMN valid_from SET DEFAULT 0, ALTER COLUMN valid_from_seq SET DEFAULT 0`,
    `DELETE FROM participants WHERE valid_to IS NOT NULL OR valid_to_seq IS NOT NULL`,
  ],
};

const SPEND_TRIGGERS = [
  `CREATE OR REPLACE FUNCTION invalidate_request_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_request_spend$
   BEGIN
     INSERT INTO session_spend_dirty(tenant_id, day)
     SELECT DISTINCT tenant, floor(at::numeric / 86400000)::bigint
       FROM (VALUES
         (CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.tenant_id END,
          CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.created_at END),
         (CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.tenant_id END,
          CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.created_at END)
       ) changed(tenant, at) WHERE at IS NOT NULL
     ON CONFLICT DO NOTHING;
     RETURN NULL;
   END $invalidate_request_spend$`,
  `CREATE OR REPLACE FUNCTION invalidate_session_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_session_spend$
   BEGIN
     IF TG_OP = 'UPDATE' AND ROW(OLD.id, OLD.scope_id, OLD.origin, OLD.thread_ref, OLD.parent_session_id)
          IS NOT DISTINCT FROM ROW(NEW.id, NEW.scope_id, NEW.origin, NEW.thread_ref, NEW.parent_session_id) THEN
       RETURN NULL;
     END IF;
     INSERT INTO session_spend_dirty(tenant_id, session_id)
     SELECT DISTINCT tenant, id FROM (VALUES (OLD.tenant_id, OLD.id), (NEW.tenant_id, NEW.id)) changed(tenant, id)
      WHERE id IS NOT NULL;
     RETURN NULL;
   END $invalidate_session_spend$`,
];

const SESSION_TABLES = tenantTables(
  "sessions/store/0056-tenants",
  [
    {
      table: "sessions",
      primaryKey: "id",
      unique: [{ name: "sessions_thread_ref_key", columns: "thread_ref", constraint: true }],
    },
    { table: "participants", primaryKey: "session_id, principal_id" },
    { table: "session_goals", primaryKey: "session_id" },
    { table: "session_leases", primaryKey: "session_id" },
    { table: "session_llm_requests", primaryKey: "id" },
    { table: "session_pins", primaryKey: "id" },
    { table: "session_spend_days", primaryKey: "day" },
    {
      table: "session_spend_dirty",
      unique: [{ name: "session_spend_dirty_day_writer_key", columns: "day, writer", constraint: true }],
    },
    { table: "llm_prompt_envelopes", primaryKey: "hash" },
  ],
  {
    tenanted: ["items", "blobs"],
    references: [
      {
        table: "items",
        name: "items_session_id_fkey",
        columns: "session_id",
        references: "sessions(tenant_id, id)",
        onDelete: "CASCADE",
      },
      {
        table: "session_goals",
        name: "session_goals_session_id_fkey",
        columns: "session_id",
        references: "sessions(tenant_id, id)",
        onDelete: "CASCADE",
      },
    ],
    after: [
      ...SPEND_TRIGGERS,
      ...["items", "blobs"].flatMap(tenantRowSecurity),
      `DO $unstamped$
       BEGIN
         DELETE FROM tenants WHERE id = (SELECT id FROM qm_tenant) AND settings = '{}'::jsonb;
       EXCEPTION WHEN foreign_key_violation THEN NULL;
       END $unstamped$`,
      `DROP FUNCTION qm_tenant_id()`,
      `DROP TABLE qm_tenant`,
    ],
  },
);

const SESSION_CLAIMS: PgMigrationDefinition = {
  id: "sessions/store/0057-claims",
  statements: [
    claimFunction(
      "claim_dirty_spend",
      "",
      "SELECT DISTINCT tenant_id, 'spend'::text FROM session_spend_dirty ORDER BY tenant_id",
    ),
    claimFunction(
      "claim_purged_envelopes",
      "cutoff bigint, lim integer",
      `DELETE FROM llm_prompt_envelopes
        WHERE (tenant_id, hash) IN (SELECT tenant_id, hash FROM llm_prompt_envelopes WHERE created_at < $1
                                     ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          AND created_at < $1
        RETURNING tenant_id, hash`,
    ),
  ],
};

const SESSION_PERSONA: PgMigrationDefinition = {
  id: "sessions/store/0056-persona",
  statements: [`SET LOCAL lock_timeout = '5s'`, `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS persona_id TEXT`],
};

const DROP_STOPPED_PLACEHOLDERS: PgMigrationDefinition = {
  id: "sessions/store/0057-drop-stopped-placeholders",
  statements: [
    `CREATE TEMP TABLE stopped_placeholders ON COMMIT DROP AS
      SELECT m.tenant_id, m.session_id, m.seq
        FROM items m
       WHERE m.kind = 'AgentMessage' AND m.variant IS DISTINCT FROM 'files_delivered'
         AND m.search @@ 'stopped'::tsquery AND m.text = '(stopped)'
         AND (SELECT p.kind FROM items p
               WHERE p.tenant_id = m.tenant_id AND p.session_id = m.session_id AND p.seq < m.seq
               ORDER BY p.seq DESC LIMIT 1) = 'Stop'`,
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE items DISABLE TRIGGER items_delete_through_session`,
    `DELETE FROM items i USING stopped_placeholders s
      WHERE i.tenant_id = s.tenant_id AND i.session_id = s.session_id AND i.seq = s.seq`,
    `ALTER TABLE items ENABLE TRIGGER items_delete_through_session`,
  ],
};

const USER_TURNS_BY_AUTHOR: PgMigrationDefinition = {
  id: "sessions/store/0058-user-turns-by-author",
  statements: [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS items_user_turns_by_author ON items(tenant_id, author, created_at)
      WHERE ${authoredUserTurn("items")}`,
  ],
};

export const DROP_SESSION_LEASES: PgMigrationDefinition = {
  id: "sessions/store/0059-drop-session-leases",
  statements: [`SET LOCAL lock_timeout = '5s'`, `DROP TABLE IF EXISTS session_leases`],
};

const DROP_ITEMS_TARGET_SEQ: PgMigrationDefinition = {
  id: "sessions/store/0060-drop-items-target-seq",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE items DROP CONSTRAINT IF EXISTS items_target_seq_kind, DROP COLUMN IF EXISTS target_seq`,
  ],
};

const DROP_PARTICIPANT_WINDOWS: PgMigrationDefinition = {
  id: "sessions/store/0061-drop-participant-windows",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `DELETE FROM participants WHERE valid_to IS NOT NULL OR valid_to_seq IS NOT NULL`,
    `ALTER TABLE participants DROP COLUMN IF EXISTS valid_from, DROP COLUMN IF EXISTS valid_to,
       DROP COLUMN IF EXISTS valid_from_seq, DROP COLUMN IF EXISTS valid_to_seq`,
  ],
};

const HUMAN_PROMPT_INDEX: PgMigrationDefinition = {
  id: "sessions/store/0062-human-prompt-index",
  statements: [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS items_human_prompt ON items(tenant_id, session_id, seq DESC)
     WHERE kind IN ('UserMessage', 'SteeringMessage') AND hidden IS DISTINCT FROM true
       AND NOT (body @> '{"overheard":true}')
       AND (body->>'speakerId' IS NOT NULL OR body @> '{"slackReplyReceipt":true}'
         OR (kind = 'SteeringMessage' AND author IS NOT NULL))`,
  ],
};

const BOT_WORK_COLUMN: PgMigrationDefinition = {
  id: "sessions/store/0064-bot-work",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE OR REPLACE FUNCTION session_bot_work(spawn_meta TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $bot_work$
BEGIN
  RETURN COALESCE(spawn_meta::jsonb -> 'botActor' = 'true'::jsonb, false);
EXCEPTION WHEN invalid_text_representation OR untranslatable_character THEN
  RETURN false;
END $bot_work$`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS bot_work BOOLEAN NOT NULL GENERATED ALWAYS AS (session_bot_work(spawn_meta)) STORED`,
  ],
};

const BACKFILL_NULL_CALL_IDS: PgMigrationDefinition = {
  id: "sessions/store/0065-backfill-null-call-ids",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TEMP TABLE null_call_items ON COMMIT DROP AS
      SELECT tenant_id, session_id, turn_id, kind, seq,
             row_number() OVER (PARTITION BY tenant_id, session_id, turn_id, kind ORDER BY seq) AS rn
        FROM items WHERE call_id IS NULL AND kind IN ('ToolCall', 'ToolResult')`,
    `CREATE TEMP TABLE backfilled_call_ids ON COMMIT DROP AS
      SELECT tenant_id, session_id, turn_id, rn, 'call_backfill_' || gen_random_uuid() AS call_id
        FROM null_call_items WHERE kind = 'ToolCall'`,
    `INSERT INTO backfilled_call_ids
      SELECT r.tenant_id, r.session_id, r.turn_id, r.rn, 'call_backfill_' || gen_random_uuid()
        FROM null_call_items r
       WHERE r.kind = 'ToolResult' AND NOT EXISTS (
         SELECT 1 FROM null_call_items c
          WHERE c.kind = 'ToolCall' AND c.tenant_id = r.tenant_id AND c.session_id = r.session_id
            AND c.turn_id IS NOT DISTINCT FROM r.turn_id AND c.rn = r.rn)`,
    `DO $backfill_null_call_ids$ BEGIN
       IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'items_append_only' AND tgrelid = 'items'::regclass) THEN
         ALTER TABLE items DISABLE TRIGGER items_append_only;
       END IF;
     END $backfill_null_call_ids$`,
    `UPDATE items i SET call_id = b.call_id
       FROM null_call_items n
       JOIN backfilled_call_ids b
         ON b.tenant_id = n.tenant_id AND b.session_id = n.session_id
        AND b.turn_id IS NOT DISTINCT FROM n.turn_id AND b.rn = n.rn
      WHERE i.tenant_id = n.tenant_id AND i.session_id = n.session_id AND i.seq = n.seq`,
    `DO $backfill_null_call_ids$ BEGIN
       IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'items_append_only' AND tgrelid = 'items'::regclass) THEN
         ALTER TABLE items ENABLE TRIGGER items_append_only;
       END IF;
     END $backfill_null_call_ids$`,
  ],
};

const TOOL_CALL_ID_CONSTRAINT: PgMigrationDefinition = {
  id: "sessions/store/0066-tool-call-id-constraint",
  autocommit: true,
  statements: [
    `ALTER TABLE items DROP CONSTRAINT IF EXISTS items_tool_call_id_present`,
    `ALTER TABLE items ADD CONSTRAINT items_tool_call_id_present
       CHECK (call_id IS NOT NULL OR kind NOT IN ('ToolCall', 'ToolResult')) NOT VALID`,
    `ALTER TABLE items VALIDATE CONSTRAINT items_tool_call_id_present`,
  ],
};

const SESSION_EPHEMERAL: PgMigrationDefinition = {
  id: "sessions/store/0067-ephemeral",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ephemeral BOOLEAN NOT NULL DEFAULT false`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_ephemeral_created ON sessions (id) WHERE ephemeral = true`,
  ],
};

const SESSION_EPHEMERAL_CLAIM: PgMigrationDefinition = {
  id: "sessions/store/0068-ephemeral-claim",
  statements: [
    claimFunction(
      "claim_expired_ephemeral_sessions",
      "cutoff bigint, lim integer, after_id text DEFAULT ''",
      `SELECT tenant_id, id FROM sessions
        WHERE ephemeral = true AND COALESCE(last_activity, created_at) < $1 AND id > $3
        ORDER BY id LIMIT $2`,
    ),
  ],
};

const PARTICIPANT_NOTIFIED_AT: PgMigrationDefinition = {
  id: "sessions/store/0069-participant-notified-at",
  statements: [`SET LOCAL lock_timeout = '5s'`, `ALTER TABLE participants ADD COLUMN IF NOT EXISTS notified_at BIGINT`],
};

export const SESSION_MIGRATIONS = [
  ...TENANCY,
  SESSION_SCHEMA,
  MESSAGE_SEARCH_INDEX,
  DROP_ITEMS_SEARCH,
  TENANT_BACKFILL,
  SPEND_RECOVERY_INDEX,
  SESSION_FACTS,
  PARTICIPANT_MEMBERSHIP,
  DROP_TENANT_PREBUILD_INDEXES,
  ...SESSION_TABLES,
  SESSION_CLAIMS,
  SESSION_PERSONA,
  DROP_STOPPED_PLACEHOLDERS,
  USER_TURNS_BY_AUTHOR,
  DROP_SESSION_LEASES,
  DROP_ITEMS_TARGET_SEQ,
  DROP_PARTICIPANT_WINDOWS,
  HUMAN_PROMPT_INDEX,
  BOT_WORK_COLUMN,
  BACKFILL_NULL_CALL_IDS,
  TOOL_CALL_ID_CONSTRAINT,
  SESSION_EPHEMERAL,
  SESSION_EPHEMERAL_CLAIM,
  PARTICIPANT_NOTIFIED_AT,
];

export const ancestry = (seed: string): string => `ancestry AS (
         SELECT s.id AS session_id, s.parent_session_id, s.origin AS origin, s.origin_id AS cron_id,
                ARRAY[s.id] AS path
           FROM sessions s
          WHERE ${seed}
         UNION ALL
         SELECT a.session_id, p.parent_session_id, p.origin, p.origin_id, a.path || p.id
           FROM ancestry a JOIN sessions p ON p.id = a.parent_session_id
          WHERE a.origin = 'conversation' AND NOT p.id = ANY(a.path) AND cardinality(a.path) < 64
       )`;
