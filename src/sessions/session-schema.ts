import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const SPEND_INDEXABLE = `(spend_usage_json(usage_json) IS NOT NULL
  AND octet_length(session_id) + octet_length(model) + octet_length(usage_json) <= 2000)`;

const PREVIOUS_SCHEMA = "sessions/store/0046-spend-days-cron-rebuild";

export const SESSION_SCHEMA: PgMigrationDefinition = {
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
