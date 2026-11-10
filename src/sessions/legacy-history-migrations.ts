import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const ITEMS_CUTOVER_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "sessions/store/0035-items",
    expectedChecksum: "b3f15f62b55af30d7f6b79f037a09d157ea1e1ad9aad5702742dff01263c016d",
    statements: [
      `DO $operator$ BEGIN
             IF to_regclass('items_copy_ops.state') IS NOT NULL THEN
               RAISE EXCEPTION 'An items copy is staged; complete the coordinated cutover before applying this migration';
             END IF;
           END $operator$`,
      `CREATE TABLE IF NOT EXISTS qm_tenant(id UUID PRIMARY KEY)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS qm_tenant_singleton ON qm_tenant((true))`,
      `INSERT INTO qm_tenant(id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM qm_tenant)`,
      `CREATE TABLE IF NOT EXISTS qm_settings(
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
      `DO $item_kind$ BEGIN
     CREATE TYPE item_kind AS ENUM ('UserMessage', 'SteeringMessage', 'AgentMessage', 'Reasoning', 'ToolCall', 'ToolResult', 'Elicitation', 'ElicitationResponse', 'Wake', 'Error', 'ContextCompaction', 'Retraction', 'Stop', 'RuntimeChange');
   EXCEPTION WHEN duplicate_object THEN NULL; END $item_kind$`,
      `DO $wake_cause$ BEGIN
     CREATE TYPE wake_cause AS ENUM ('cron', 'webhook', 'child_done', 'system');
   EXCEPTION WHEN duplicate_object THEN NULL; END $wake_cause$`,
      `CREATE TABLE IF NOT EXISTS blobs(
     tenant_id UUID NOT NULL,
     sha256 BYTEA NOT NULL CHECK (length(sha256) = 32),
     size BIGINT NOT NULL CHECK (size >= 0),
     mime TEXT,
     storage_key TEXT NOT NULL CHECK (storage_key <> ''),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ,
     PRIMARY KEY (tenant_id, sha256)
   )`,
      `CREATE TABLE IF NOT EXISTS items(
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
     target_seq BIGINT,
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
     CONSTRAINT items_target_seq_kind CHECK (target_seq IS NULL OR kind IN ('Retraction')),
     CONSTRAINT items_approved_kind CHECK (approved IS NULL OR kind IN ('ElicitationResponse')),
     CONSTRAINT items_blob_sha_kind CHECK (blob_sha IS NULL OR kind IN ('ToolResult')),
     CONSTRAINT items_blob FOREIGN KEY (tenant_id, blob_sha) REFERENCES blobs(tenant_id, sha256)
   )`,
      String.raw`CREATE OR REPLACE FUNCTION items_copy_payload(t text) RETURNS jsonb
             LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $items_copy_payload$
             DECLARE r text;
             BEGIN
               IF t IS NULL OR strpos(t, E'\\u') = 0 THEN RETURN t::jsonb; END IF;
               IF pg_input_is_valid(t, 'jsonb') THEN RETURN t::jsonb; END IF;
               r := regexp_replace(t, '(?<!\\)((?:\\\\)*)\\u0000', '\1', 'g');
               IF NOT pg_input_is_valid(r, 'jsonb') THEN
                 r := regexp_replace(regexp_replace(r,
                   '(?<!\\)((?:\\\\)*)\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})', '\1\\ufffd', 'g'),
                   '(?<!\\)((?:\\\\)*)(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}', '\1\\ufffd', 'g');
               END IF;
               RETURN r::jsonb;
             END $items_copy_payload$`,
      `CREATE OR REPLACE FUNCTION items_copy_payload(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS 'SELECT j'`,
      `SET LOCAL statement_timeout = 0`,
      `WITH inserted AS (
    INSERT INTO items(tenant_id, session_id, seq, turn_id, kind, author, call_id, elicit_id, wake_cause, error_code,
                   text, tool, step, variant, is_error, hidden, external_id, through_seq, target_seq, approved,
                   body, created_at) WITH ambiguous_calls AS MATERIALIZED (SELECT DISTINCT session_id, call_id FROM (
    SELECT e.session_id, e.type, n.body ->> 'callId' AS call_id
    FROM session_entries e
      CROSS JOIN LATERAL (SELECT items_copy_payload(e.payload) AS j OFFSET 0) parsed
  CROSS JOIN LATERAL (
    SELECT CASE WHEN parsed.j IS NULL OR jsonb_typeof(parsed.j) = 'null' THEN '{}'::jsonb
                WHEN jsonb_typeof(parsed.j) = 'object' THEN parsed.j
                WHEN jsonb_typeof(parsed.j) = 'string' THEN jsonb_build_object('text', parsed.j)
                ELSE jsonb_build_object('value', parsed.j)
           END AS body
    OFFSET 0
  ) n

    WHERE e.type IN ('tool_call', 'tool_result')
      
      AND jsonb_typeof(n.body -> 'callId') = 'string'
      AND octet_length(n.body ->> 'callId') BETWEEN 1 AND 1024
    GROUP BY e.session_id, e.type, n.body ->> 'callId'
    HAVING count(*) > 1
  ) repeated)
SELECT (SELECT id FROM qm_tenant), e.session_id, e.seq,
       CASE WHEN t.run_is_uuid THEN (n.body ->> 'runId')::uuid END,
       k.kind,
       a.author,
       CASE WHEN k.kind IN ('ToolCall', 'ToolResult') AND octet_length(CASE WHEN jsonb_typeof(n.body -> 'callId') = 'string' THEN n.body ->> 'callId' END) <= 1024 AND ambiguous.call_id IS NULL
            THEN NULLIF(CASE WHEN jsonb_typeof(n.body -> 'callId') = 'string' THEN n.body ->> 'callId' END, '') END,
       CASE WHEN k.kind IN ('Elicitation', 'ElicitationResponse') THEN
         COALESCE(NULLIF(CASE WHEN jsonb_typeof(n.body -> 'requestId') = 'string' THEN n.body ->> 'requestId' END, ''), 'missing-elicit:' || e.seq) END,
       CASE WHEN k.kind = 'Wake' THEN
         CASE WHEN n.body ? 'cause' THEN (n.body ->> 'cause')::wake_cause ELSE 'system'::wake_cause END END,
       CASE WHEN k.kind = 'Error' THEN 'turn_failure' END,
       NULLIF(n.body ->> s.text_key, ''),
       CASE WHEN k.kind IN ('ToolCall', 'ToolResult') THEN NULLIF(CASE WHEN jsonb_typeof(n.body -> 'tool') = 'string' THEN n.body ->> 'tool' END, '') END,
       s.step,
       CASE e.type WHEN 'text' THEN 'narration' WHEN 'delivery' THEN 'files_delivered' END,
       CASE WHEN k.kind = 'ToolResult' AND jsonb_typeof(n.body -> 'isError') = 'boolean' THEN (n.body -> 'isError')::boolean END,
       CASE WHEN k.kind = 'UserMessage' AND jsonb_typeof(n.body -> 'hidden') = 'boolean' THEN (n.body -> 'hidden')::boolean END,
       CASE WHEN k.kind = 'UserMessage' THEN NULLIF(CASE WHEN jsonb_typeof(n.body -> 'ts') = 'string' THEN n.body ->> 'ts' END, '') END,
       CASE WHEN k.kind = 'ContextCompaction' AND jsonb_typeof(n.body -> 'throughSeq') = 'number' THEN (n.body ->> 'throughSeq')::numeric::bigint END,
       a.target_seq,
       CASE WHEN k.kind = 'ElicitationResponse' AND jsonb_typeof(n.body -> 'approved') = 'boolean' THEN (n.body -> 'approved')::boolean END,
       x.body,
       to_timestamp(e.created_at / 1000.0)
  FROM sessions sess
  CROSS JOIN LATERAL (
    SELECT COALESCE(max(i.seq), -1) AS seq FROM items i WHERE i.tenant_id = (SELECT id FROM qm_tenant) AND i.session_id = sess.id
  ) copied
  CROSS JOIN LATERAL (
    SELECT * FROM session_entries d WHERE d.session_id = sess.id AND d.seq > copied.seq OFFSET 0
  ) e
  CROSS JOIN LATERAL (SELECT items_copy_payload(e.payload) AS j OFFSET 0) parsed
  CROSS JOIN LATERAL (
    SELECT CASE WHEN parsed.j IS NULL OR jsonb_typeof(parsed.j) = 'null' THEN '{}'::jsonb
                WHEN jsonb_typeof(parsed.j) = 'object' THEN parsed.j
                WHEN jsonb_typeof(parsed.j) = 'string' THEN jsonb_build_object('text', parsed.j)
                ELSE jsonb_build_object('value', parsed.j)
           END AS body
    OFFSET 0
  ) n
  CROSS JOIN LATERAL (
    SELECT (CASE e.type
              WHEN 'user' THEN CASE WHEN n.body @> '{"steered":true}' THEN 'SteeringMessage' ELSE 'UserMessage' END
              WHEN 'assistant' THEN 'AgentMessage'
              WHEN 'text' THEN 'AgentMessage'
              WHEN 'delivery' THEN 'AgentMessage'
              WHEN 'thinking' THEN 'Reasoning'
              WHEN 'tool_call' THEN 'ToolCall'
              WHEN 'tool_result' THEN 'ToolResult'
              WHEN 'approval_request' THEN 'Elicitation'
              WHEN 'approval_resolved' THEN 'ElicitationResponse'
              WHEN 'soul' THEN NULL
              WHEN 'text_start' THEN NULL
              WHEN 'system' THEN
                CASE n.body ->> 'kind'
                  WHEN 'context_summary' THEN 'ContextCompaction'
                  WHEN 'turn_failure' THEN 'Error'
                  WHEN 'turn_stopped' THEN 'Stop'
                  WHEN 'wake' THEN 'Wake'
                  WHEN 'goal_cancelled' THEN 'Wake'
                  WHEN 'message_revision' THEN 'Retraction'
                  WHEN 'goal' THEN NULL
                  WHEN 'memory_context' THEN NULL
                  WHEN 'file_event' THEN NULL
                  ELSE 'unmapped system entry kind=' || COALESCE(n.body ->> 'kind', '(none)') || ' at '
                       || e.session_id || '/' || e.seq
                END
              ELSE 'unmapped entry type=' || e.type || ' at ' || e.session_id || '/' || e.seq
            END)::item_kind AS kind
    OFFSET 0
  ) k
  LEFT JOIN ambiguous_calls ambiguous
    ON ambiguous.session_id=e.session_id AND ambiguous.call_id=n.body ->> 'callId'
  LEFT JOIN legacy_tape_steps l ON l.session_id = e.session_id AND l.seq = e.seq
  CROSS JOIN LATERAL (
    SELECT CASE WHEN k.kind IN ('UserMessage', 'SteeringMessage', 'AgentMessage', 'ContextCompaction') THEN 'text'
                WHEN k.kind = 'Reasoning' THEN 'thinking'
                WHEN k.kind = 'ToolResult' THEN 'result'
                WHEN k.kind = 'Error' THEN 'message'
           END AS text_key,
           CASE WHEN k.kind IN ('ToolCall', 'ToolResult', 'Reasoning', 'AgentMessage') THEN
             COALESCE(CASE WHEN jsonb_typeof(n.body -> 'step') = 'object' THEN n.body -> 'step' END, l.step) END AS step_obj,
           pg_input_is_valid(n.body ->> 'runId', 'uuid') AS run_is_uuid
  ) t
  CROSS JOIN LATERAL (
    SELECT CASE WHEN jsonb_typeof(n.body -> t.text_key) = 'string' THEN t.text_key END AS text_key,
           CASE WHEN jsonb_typeof(t.step_obj -> 'index') = 'number' THEN (t.step_obj ->> 'index')::int END AS step,
           CASE WHEN t.step_obj IS NOT NULL
                THEN COALESCE(CASE WHEN jsonb_typeof(n.body -> 'wire') = 'object' THEN n.body -> 'wire' END, l.wire, '{}'::jsonb)
                     || jsonb_build_object('message', t.step_obj - 'index')
                WHEN NOT n.body ? 'wire' AND l.wire IS NOT NULL THEN l.wire
           END AS wire
  ) s
  CROSS JOIN LATERAL (
    SELECT CASE WHEN k.kind IN ('UserMessage', 'SteeringMessage', 'ElicitationResponse', 'Stop') AND n.body ->> 'sourceRole' IS DISTINCT FROM 'agent' THEN
             COALESCE(
               CASE WHEN NOT n.body @> '{"overheard":true}' THEN
                 (SELECT min(p.principal_id) FROM participants p
                   WHERE p.session_id = e.session_id AND p.valid_from <= e.created_at
                     AND (p.valid_to IS NULL OR p.valid_to > e.created_at)
                  HAVING count(*) = 1) END,
               CASE WHEN btrim(CASE WHEN jsonb_typeof(n.body -> 'name') = 'string' THEN n.body ->> 'name' END) <> '' THEN
                 (SELECT min(p.principal_id) FROM participants p
                   WHERE p.session_id = e.session_id
                     AND EXISTS (SELECT 1 FROM directory_members d
                                  WHERE d.principal_id = p.principal_id
                                    AND d.display_name_lc = lower(btrim(n.body ->> 'name')))
                  HAVING count(*) = 1) END)
           END AS author,
           CASE WHEN k.kind = 'Retraction' AND jsonb_typeof(n.body -> 'ts') = 'string' THEN
             (SELECT max(u.seq) FROM session_entries u
               WHERE u.session_id = e.session_id AND u.seq < e.seq AND u.type = 'user'
                 AND items_copy_payload(u.payload) ->> 'ts' = n.body ->> 'ts') END AS target_seq
    OFFSET 0
  ) a
  CROSS JOIN LATERAL (
    SELECT n.body - array_remove(ARRAY[
             'securityTainted',
             CASE WHEN e.type = 'assistant' OR k.kind = 'Error' THEN 'deliveryKey' END,
             s.text_key,
             CASE WHEN k.kind IN ('ToolCall', 'ToolResult') THEN 'tool' END,
             CASE WHEN k.kind IN ('ToolCall', 'ToolResult') THEN 'callId' END,
             CASE WHEN k.kind IN ('Elicitation', 'ElicitationResponse') THEN 'requestId' END,
             CASE WHEN k.kind = 'ToolResult' AND jsonb_typeof(n.body -> 'isError') = 'boolean' THEN 'isError' END,
             CASE WHEN k.kind = 'UserMessage' AND jsonb_typeof(n.body -> 'hidden') = 'boolean' THEN 'hidden' END,
             CASE WHEN k.kind = 'UserMessage' AND jsonb_typeof(n.body -> 'ts') = 'string' THEN 'ts' END,
             CASE WHEN e.type = 'user' THEN 'steered' END,
             CASE WHEN k.kind = 'ContextCompaction' AND jsonb_typeof(n.body -> 'throughSeq') = 'number' THEN 'throughSeq' END,
             CASE WHEN k.kind = 'ElicitationResponse' AND jsonb_typeof(n.body -> 'approved') = 'boolean' THEN 'approved' END,
             CASE WHEN e.type = 'system' AND n.body ->> 'kind' <> 'goal_cancelled' THEN 'kind' END,
             CASE WHEN k.kind = 'Wake' THEN 'cause' END,
             CASE WHEN t.run_is_uuid THEN 'runId' END,
             CASE WHEN t.step_obj IS NOT NULL THEN 'step' END,
             CASE WHEN s.wire IS NOT NULL THEN 'wire' END,
             CASE WHEN s.text_key = 'result' AND jsonb_typeof(n.body -> 'stdout') = 'string'
                       AND strpos(n.body ->> 'result', n.body ->> 'stdout') > 0 THEN 'stdout' END,
             CASE WHEN s.text_key = 'result' AND jsonb_typeof(n.body -> 'stderr') = 'string'
                       AND strpos(n.body ->> 'result', n.body ->> 'stderr') > 0 THEN 'stderr' END
           ]::text[], NULL)
           || CASE WHEN s.wire IS NOT NULL THEN jsonb_build_object('wire', s.wire) ELSE '{}'::jsonb END AS body
  ) x
 WHERE k.kind IS NOT NULL RETURNING kind,author
  ) SELECT count(*)::int AS rows,
           count(*) FILTER (WHERE kind IN ('UserMessage', 'SteeringMessage', 'ElicitationResponse', 'Stop'))::int AS author_eligible,
           count(*) FILTER (WHERE kind IN ('UserMessage', 'SteeringMessage', 'ElicitationResponse', 'Stop') AND author IS NULL)::int AS author_null
      FROM inserted`,
      `CREATE UNIQUE INDEX IF NOT EXISTS items_one_call_per_kind ON items(tenant_id, session_id, kind, call_id) WHERE call_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_by_turn ON items(tenant_id, turn_id, seq) WHERE turn_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_by_elicit ON items(tenant_id, session_id, elicit_id) WHERE elicit_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_by_external_id ON items(tenant_id, session_id, external_id) WHERE external_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_session_kind_created ON items(tenant_id, session_id, kind, created_at)`,
      `CREATE INDEX IF NOT EXISTS items_search ON items USING gin (tenant_id, session_id, search)`,
    ],
  },
  {
    id: "sessions/store/0035-items-keep-call-ids",
    statements: [
      `SET LOCAL statement_timeout = 0`,
      `DO $keep_call_ids$
   BEGIN
     IF to_regclass('session_entries') IS NULL
        OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'items_append_only' AND tgrelid = 'items'::regclass) THEN
       RETURN;
     END IF;
     UPDATE items i SET body = i.body || jsonb_build_object('callId', p.j ->> 'callId')
       FROM session_entries e CROSS JOIN LATERAL (SELECT items_copy_payload(e.payload) AS j OFFSET 0) p
      WHERE i.kind IN ('ToolCall', 'ToolResult') AND i.call_id IS NULL
        AND e.session_id = i.session_id AND e.seq = i.seq
        AND jsonb_typeof(p.j -> 'callId') = 'string' AND p.j ->> 'callId' <> '';
   END $keep_call_ids$`,
    ],
  },
  {
    id: "sessions/store/0036-items-cutover",
    expectedChecksum: "43c41a637d03afe4ce8d1314298783a8190c56da4e0d25aa3bf810c13fb6f439",
    statements: [
      `SET LOCAL lock_timeout = '60s'`,
      `DO $index_guard$
   DECLARE unready text;
   BEGIN
     SELECT string_agg(name, ', ') INTO unready
       FROM unnest(ARRAY['items_one_call_per_kind', 'items_by_turn', 'items_by_elicit', 'items_by_external_id', 'items_session_kind_created', 'items_search']) AS name
      WHERE NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                         WHERE c.relname = name AND c.relnamespace = current_schema()::regnamespace AND i.indisvalid);
     IF unready IS NOT NULL AND EXISTS (SELECT 1 FROM items) THEN
       RAISE EXCEPTION 'items cutover: build the items indexes with scripts/ops/items-copy.ts first; missing or invalid: %', unready;
     END IF;
   END $index_guard$`,
      `CREATE UNIQUE INDEX IF NOT EXISTS items_one_call_per_kind ON items(tenant_id, session_id, kind, call_id) WHERE call_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_by_turn ON items(tenant_id, turn_id, seq) WHERE turn_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_by_elicit ON items(tenant_id, session_id, elicit_id) WHERE elicit_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_by_external_id ON items(tenant_id, session_id, external_id) WHERE external_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_session_kind_created ON items(tenant_id, session_id, kind, created_at)`,
      `CREATE INDEX IF NOT EXISTS items_search ON items USING gin (tenant_id, session_id, search)`,
      `CREATE OR REPLACE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
     AS $qm_tenant_id$ SELECT id FROM qm_tenant $qm_tenant_id$`,
      `CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $forbid_mutation$
   BEGIN
     RAISE EXCEPTION '% on % is forbidden', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
   END $forbid_mutation$`,
      `CREATE OR REPLACE FUNCTION forbid_direct_delete() RETURNS trigger LANGUAGE plpgsql AS $forbid_direct_delete$
   BEGIN
     IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
     RAISE EXCEPTION 'DELETE on % is only allowed through its session', TG_TABLE_NAME
       USING ERRCODE = 'integrity_constraint_violation';
   END $forbid_direct_delete$`,
      `CREATE TRIGGER items_append_only BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
      `CREATE TRIGGER items_no_truncate BEFORE TRUNCATE ON items FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
      `CREATE TRIGGER items_delete_through_session BEFORE DELETE ON items
   FOR EACH ROW EXECUTE FUNCTION forbid_direct_delete()`,
      `CREATE TRIGGER blobs_immutable BEFORE UPDATE OR DELETE ON blobs FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
      `CREATE TRIGGER blobs_no_truncate BEFORE TRUNCATE ON blobs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
      `CREATE OR REPLACE FUNCTION sync_item_search() RETURNS trigger
   LANGUAGE plpgsql AS $sync_item_search$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
       RETURN OLD;
     END IF;
     IF (NEW.kind IN ('UserMessage','SteeringMessage','AgentMessage') AND NEW.variant IS DISTINCT FROM 'files_delivered' AND NEW.text IS NOT NULL) AND btrim(NEW.text) <> '' THEN
       INSERT INTO session_entry_search(session_id, seq, type, author, text, created_at)
       VALUES (NEW.session_id, NEW.seq, CASE WHEN NEW.kind IN ('UserMessage', 'SteeringMessage') THEN 'user' WHEN NEW.variant = 'narration' THEN 'text' ELSE 'assistant' END,
               CASE WHEN NEW.kind IN ('UserMessage', 'SteeringMessage') AND jsonb_typeof(NEW.body -> 'name') = 'string'
                    THEN NEW.body ->> 'name' END,
               NEW.text, (EXTRACT(EPOCH FROM NEW.created_at) * 1000)::bigint)
       ON CONFLICT (session_id, seq) DO NOTHING;
     END IF;
     RETURN NEW;
   END $sync_item_search$`,
      `CREATE TRIGGER session_entry_search AFTER INSERT OR DELETE ON items
   FOR EACH ROW EXECUTE FUNCTION sync_item_search()`,
      `DROP TRIGGER IF EXISTS session_entries_search_write_through ON session_entries`,
      `DROP FUNCTION IF EXISTS sync_session_entry_search()`,
      `DROP TRIGGER IF EXISTS participant_activity_boundary_insert_v3 ON participants`,
      `DROP TRIGGER IF EXISTS participant_activity_reopen_v3 ON participants`,
      `DROP TRIGGER IF EXISTS participant_activity_entry_v3 ON session_entries`,
      `DROP TRIGGER IF EXISTS session_entry_boundary_v1 ON session_entries`,
      `DROP FUNCTION IF EXISTS participant_activity_on_insert_v3(), participant_activity_on_reopen_v3(),
     participant_activity_on_entry_v3(), session_entry_boundary_v1()`,
      `ALTER TABLE session_entries RENAME TO legacy_session_entries`,
    ],
  },
];
