import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

// Released migrations that moved session history off session_tape and session_entries into items.
// They are kept verbatim so a deployment upgrading from an older release still copies its history
// on startup before sessions/store/0037-drop-legacy-history removes the old tables. Already-migrated
// databases skip them by id. Their checksums are pinned: never edit these statements. Delete this
// file once every supported deployment has applied sessions/store/0036-items-cutover.

export const LEGACY_TAPE_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "sessions/store/0029-legacy-tape-steps",
    expectedChecksum: "a103ebb697c0d2cdf4a843791127955ff6c42729ca1ba5880446e02aa24e7235",
    statements: [
      `CREATE TABLE IF NOT EXISTS legacy_tape_steps(
    session_id TEXT NOT NULL,
    seq INT NOT NULL,
    step JSONB NOT NULL,
    wire JSONB,
    PRIMARY KEY (session_id, seq)
  )`,
      `CREATE TABLE IF NOT EXISTS legacy_turn_runs(
    session_id TEXT NOT NULL,
    seq INT NOT NULL,
    run_id TEXT NOT NULL,
    inferred BOOLEAN NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`,
      `CREATE TABLE IF NOT EXISTS legacy_tape_steps_progress(
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    started_at BIGINT,
    last_session TEXT,
    done BOOLEAN NOT NULL DEFAULT false,
    invalid_messages BIGINT NOT NULL DEFAULT 0,
    keyed_blocks BIGINT NOT NULL DEFAULT 0,
    copied_steps BIGINT NOT NULL DEFAULT 0,
    copied_turns BIGINT NOT NULL DEFAULT 0
  )`,
      `INSERT INTO legacy_tape_steps_progress DEFAULT VALUES ON CONFLICT (singleton) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS legacy_tape_writes(at BIGINT NOT NULL)`,
      `CREATE OR REPLACE FUNCTION legacy_tape_written() RETURNS trigger LANGUAGE plpgsql AS $written$
BEGIN
  INSERT INTO legacy_tape_writes VALUES ((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint);
  RETURN NULL;
END $written$`,
      `CREATE OR REPLACE PROCEDURE prepare_legacy_tape_steps(batch INT DEFAULT 50)
LANGUAGE plpgsql AS $prepare$
DECLARE
  ids TEXT[];
  frozen_at BIGINT;
  n_invalid BIGINT;
  n_keyed BIGINT;
  n_steps BIGINT;
  n_turns BIGINT;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('prepare_legacy_tape_steps')) THEN
    RAISE EXCEPTION 'prepare_legacy_tape_steps() is already running in another session';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'legacy_tape_frozen' AND tgrelid = 'session_tape'::regclass) THEN
    IF EXISTS (SELECT 1 FROM legacy_tape_steps_progress WHERE started_at IS NOT NULL OR last_session IS NOT NULL OR done) THEN
      RAISE EXCEPTION 'legacy_tape_frozen is gone but a preparation already started: reset legacy_tape_steps_progress, legacy_tape_steps, legacy_turn_runs and legacy_tape_writes before starting again';
    END IF;
    PERFORM set_config('lock_timeout', '5s', true);
    CREATE TRIGGER legacy_tape_frozen AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON session_tape
      FOR EACH STATEMENT EXECUTE FUNCTION legacy_tape_written();
    ALTER TABLE session_tape ENABLE ALWAYS TRIGGER legacy_tape_frozen;
    UPDATE legacy_tape_steps_progress SET started_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
    COMMIT;
  END IF;
  SELECT started_at INTO frozen_at FROM legacy_tape_steps_progress;
  IF to_regclass('legacy_prep_runs') IS NULL THEN
    CREATE TABLE legacy_prep_runs(
      id TEXT, session_id TEXT, turn_user_seq BIGINT, started_at BIGINT, finished_at BIGINT, prev_max_finished BIGINT
    );
    IF to_regclass('runs') IS NOT NULL THEN
      INSERT INTO legacy_prep_runs
        SELECT r.id, s.id, r.turn_user_seq, r.started_at, r.finished_at,
               max(COALESCE(r.finished_at, 9223372036854775807)) OVER (
                 PARTITION BY s.id ORDER BY r.started_at, r.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
          FROM runs r JOIN sessions s ON s.thread_ref = r.session_id
         WHERE r.started_at IS NOT NULL;
    END IF;
    CREATE INDEX legacy_prep_runs_by_seq ON legacy_prep_runs(session_id, turn_user_seq);
    CREATE INDEX legacy_prep_runs_by_start ON legacy_prep_runs(session_id, started_at DESC, id DESC);
    COMMIT;
  END IF;
  LOOP
    SELECT array_agg(id ORDER BY id) INTO ids
      FROM (SELECT id FROM sessions
             WHERE id > COALESCE((SELECT last_session FROM legacy_tape_steps_progress), '')
             ORDER BY id LIMIT batch) next_sessions;
    EXIT WHEN ids IS NULL;
    PERFORM set_config('enable_nestloop', 'off', true);
    CREATE TEMP TABLE legacy_batch_blocks ON COMMIT DROP AS
      WITH messages AS MATERIALIZED (
        SELECT t.session_id, t.seq, t.created_at, v.valid, m.*
          FROM session_tape t
          CROSS JOIN LATERAL (
            SELECT pg_input_is_valid(t.payload, 'jsonb') AND left(btrim(t.payload), 1) = '{' AS valid OFFSET 0
          ) v
          CROSS JOIN LATERAL (
            SELECT r.* FROM json_to_record(CASE WHEN v.valid THEN t.payload::json END)
              AS r(role TEXT, api TEXT, provider TEXT, model TEXT, "stopReason" TEXT, content JSON)
            OFFSET 0
          ) m
         WHERE t.session_id = ANY(ids) AND t.kind = 'message' AND COALESCE(t.harness, 'pi') = 'pi'
           AND (NOT v.valid OR m.role = 'assistant')
      )
      SELECT m.session_id, m.seq AS tape_seq, m.created_at, m.valid, m.api, m.provider, m.model,
             m."stopReason" AS stop_reason, b.blk, (b.ord - 1)::int AS idx,
             CASE b.blk ->> 'type'
               WHEN 'toolCall' THEN 'call:' || (b.blk ->> 'id')
               WHEN 'thinking' THEN CASE WHEN COALESCE(b.blk ->> 'thinkingSignature', '') <> ''
                                         THEN 'sig:' || (b.blk ->> 'thinkingSignature') END
               WHEN 'text' THEN 'text:' || (b.blk ->> 'text')
             END AS key
        FROM messages m
        LEFT JOIN LATERAL json_array_elements(
          CASE WHEN json_typeof(m.content) = 'array' THEN m.content ELSE '[]'::json END
        ) WITH ORDINALITY AS b(blk, ord) ON true;
    SELECT count(*) FILTER (WHERE NOT valid), count(*) FILTER (WHERE key IS NOT NULL)
      INTO n_invalid, n_keyed FROM legacy_batch_blocks;
    WITH tape_unique AS (
      SELECT b.* FROM legacy_batch_blocks b
        JOIN (SELECT session_id, key FROM legacy_batch_blocks WHERE key IS NOT NULL
               GROUP BY session_id, key HAVING count(*) = 1) u USING (session_id, key)
    ), entries AS (
      SELECT e.session_id, e.seq, e.type, e.created_at, p.j,
             CASE WHEN e.type = 'tool_call' THEN 'call:' || (p.j ->> 'callId')
                  WHEN e.type = 'thinking' THEN 'sig:' || (p.j ->> 'thinkingSignature')
                  ELSE 'text:' || (p.j ->> 'text') END AS key
        FROM session_entries e
        CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(e.payload, 'jsonb') THEN e.payload::jsonb END AS j) p
       WHERE e.session_id = ANY(ids)
         AND e.type IN ('tool_call', 'thinking', 'text', 'assistant') AND e.created_at < frozen_at
         AND jsonb_typeof(p.j) = 'object' AND NOT p.j ? 'step'
    ), entries_unique AS (
      SELECT x.* FROM entries x
        JOIN (SELECT session_id, key FROM entries WHERE key IS NOT NULL
               GROUP BY session_id, key HAVING count(*) = 1) u USING (session_id, key)
    )
    INSERT INTO legacy_tape_steps(session_id, seq, step, wire)
    SELECT e.session_id, e.seq,
           jsonb_strip_nulls(jsonb_build_object('id', 'tape:' || t.tape_seq, 'api', t.api, 'provider', t.provider,
                                                'model', t.model, 'stopReason', t.stop_reason, 'index', t.idx)),
           NULLIF(
             COALESCE((SELECT jsonb_object_agg(f.key, f.value::jsonb) FROM json_each(t.blk) f
                        WHERE f.key <> ALL (CASE t.blk ->> 'type'
                                              WHEN 'toolCall' THEN ARRAY['type', 'id', 'name', 'arguments']
                                              WHEN 'thinking' THEN ARRAY['type', 'thinking', 'thinkingSignature']
                                              ELSE ARRAY['type', 'text'] END)), '{}'::jsonb)
             || CASE WHEN e.type = 'tool_call' THEN
                  jsonb_build_object('argumentsJson', COALESCE((t.blk -> 'arguments')::text, '{}'))
                  || CASE WHEN (t.blk ->> 'name') IS DISTINCT FROM (e.j ->> 'tool')
                          THEN jsonb_build_object('name', t.blk ->> 'name') ELSE '{}'::jsonb END
                ELSE '{}'::jsonb END,
             '{}'::jsonb)
      FROM entries_unique e
      JOIN tape_unique t USING (session_id, key)
     WHERE e.key NOT LIKE 'text:%' OR abs(e.created_at - t.created_at) <= 600000
    ON CONFLICT (session_id, seq) DO NOTHING;
    GET DIAGNOSTICS n_steps = ROW_COUNT;
    PERFORM set_config('enable_nestloop', 'on', true);
    INSERT INTO legacy_turn_runs(session_id, seq, run_id, inferred)
    SELECT e.session_id, e.seq, COALESCE(by_seq.id, by_window.id), by_seq.id IS NULL
      FROM session_entries e
      CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(e.payload, 'jsonb') THEN e.payload::jsonb END AS j) p
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(*) = 1 THEN min(r.id) END AS id FROM legacy_prep_runs r
         WHERE r.session_id = e.session_id AND r.turn_user_seq = e.seq
      ) by_seq ON true
      LEFT JOIN LATERAL (
        SELECT latest.id FROM (
          SELECT r.id, r.turn_user_seq, r.finished_at, r.prev_max_finished FROM legacy_prep_runs r
           WHERE r.session_id = e.session_id AND r.started_at <= e.created_at
           ORDER BY r.started_at DESC, r.id DESC LIMIT 1
        ) latest
         WHERE latest.turn_user_seq IS NULL AND e.created_at <= latest.finished_at
           AND COALESCE(latest.prev_max_finished, -1) < e.created_at
      ) by_window ON true
     WHERE e.session_id = ANY(ids) AND e.type = 'user' AND e.created_at < frozen_at AND jsonb_typeof(p.j) = 'object'
       AND NOT p.j @> '{"steered":true}' AND NOT p.j @> '{"overheard":true}'
       AND NOT COALESCE(jsonb_typeof(p.j -> 'runId') = 'string' AND p.j ->> 'runId' <> '', false)
       AND COALESCE(by_seq.id, by_window.id) IS NOT NULL
    ON CONFLICT (session_id, seq) DO NOTHING;
    GET DIAGNOSTICS n_turns = ROW_COUNT;
    UPDATE legacy_tape_steps_progress
       SET last_session = ids[array_length(ids, 1)],
           invalid_messages = invalid_messages + n_invalid, keyed_blocks = keyed_blocks + n_keyed,
           copied_steps = copied_steps + n_steps, copied_turns = copied_turns + n_turns;
    COMMIT;
  END LOOP;
  DROP TABLE legacy_prep_runs;
  UPDATE legacy_tape_steps_progress SET done = true;
  COMMIT;
  PERFORM pg_advisory_unlock(hashtext('prepare_legacy_tape_steps'));
END $prepare$`,
    ],
  },
  {
    id: "sessions/store/0030-legacy-tape-steps-size-guard",
    expectedChecksum: "3b7f668e1acedcda4613ba41110f62932b404ba93884c829aa209d744a7a12c8",
    statements: [
      `ALTER TABLE legacy_tape_steps_progress ADD COLUMN IF NOT EXISTS skipped_sessions BIGINT NOT NULL DEFAULT 0`,
      `CREATE TABLE IF NOT EXISTS legacy_tape_skipped(session_id TEXT PRIMARY KEY, error TEXT NOT NULL, at BIGINT NOT NULL)`,
      `CREATE OR REPLACE FUNCTION legacy_tape_steps_batch(
  ids TEXT[], frozen_at BIGINT, OUT n_invalid BIGINT, OUT n_keyed BIGINT, OUT n_steps BIGINT, OUT n_turns BIGINT
) LANGUAGE plpgsql AS $batch$
BEGIN
  IF to_regclass('pg_temp.legacy_batch_blocks') IS NOT NULL THEN
    DROP TABLE pg_temp.legacy_batch_blocks;
  END IF;
    PERFORM set_config('enable_nestloop', 'off', true);
    CREATE TEMP TABLE legacy_batch_blocks ON COMMIT DROP AS
      WITH messages AS MATERIALIZED (
        SELECT t.session_id, t.seq, t.created_at, v.valid, m.*
          FROM session_tape t
          CROSS JOIN LATERAL (
            SELECT CASE WHEN octet_length(t.payload) > 16777216 THEN false
                        ELSE pg_input_is_valid(t.payload, 'jsonb') AND left(btrim(t.payload), 1) = '{' END AS valid OFFSET 0
          ) v
          CROSS JOIN LATERAL (
            SELECT r.* FROM json_to_record(CASE WHEN v.valid THEN t.payload::json END)
              AS r(role TEXT, api TEXT, provider TEXT, model TEXT, "stopReason" TEXT, content JSON)
            OFFSET 0
          ) m
         WHERE t.session_id = ANY(ids) AND t.kind = 'message' AND COALESCE(t.harness, 'pi') = 'pi'
           AND (NOT v.valid OR m.role = 'assistant')
      )
      SELECT m.session_id, m.seq AS tape_seq, m.created_at, m.valid, m.api, m.provider, m.model,
             m."stopReason" AS stop_reason, b.blk, (b.ord - 1)::int AS idx,
             CASE b.blk ->> 'type'
               WHEN 'toolCall' THEN 'call:' || (b.blk ->> 'id')
               WHEN 'thinking' THEN CASE WHEN COALESCE(b.blk ->> 'thinkingSignature', '') <> ''
                                         THEN 'sig:' || (b.blk ->> 'thinkingSignature') END
               WHEN 'text' THEN 'text:' || (b.blk ->> 'text')
             END AS key
        FROM messages m
        LEFT JOIN LATERAL json_array_elements(
          CASE WHEN json_typeof(m.content) = 'array' THEN m.content ELSE '[]'::json END
        ) WITH ORDINALITY AS b(blk, ord) ON true;
    SELECT count(*) FILTER (WHERE NOT valid), count(*) FILTER (WHERE key IS NOT NULL)
      INTO n_invalid, n_keyed FROM legacy_batch_blocks;
    WITH tape_unique AS (
      SELECT b.* FROM legacy_batch_blocks b
        JOIN (SELECT session_id, key FROM legacy_batch_blocks WHERE key IS NOT NULL
               GROUP BY session_id, key HAVING count(*) = 1) u USING (session_id, key)
    ), entries AS (
      SELECT e.session_id, e.seq, e.type, e.created_at, p.j,
             CASE WHEN e.type = 'tool_call' THEN 'call:' || (p.j ->> 'callId')
                  WHEN e.type = 'thinking' THEN 'sig:' || (p.j ->> 'thinkingSignature')
                  ELSE 'text:' || (p.j ->> 'text') END AS key
        FROM session_entries e
        CROSS JOIN LATERAL (SELECT CASE WHEN octet_length(e.payload) > 16777216 THEN NULL WHEN pg_input_is_valid(e.payload, 'jsonb') THEN e.payload::jsonb END AS j) p
       WHERE e.session_id = ANY(ids)
         AND e.type IN ('tool_call', 'thinking', 'text', 'assistant') AND e.created_at < frozen_at
         AND jsonb_typeof(p.j) = 'object' AND NOT p.j ? 'step'
    ), entries_unique AS (
      SELECT x.* FROM entries x
        JOIN (SELECT session_id, key FROM entries WHERE key IS NOT NULL
               GROUP BY session_id, key HAVING count(*) = 1) u USING (session_id, key)
    )
    INSERT INTO legacy_tape_steps(session_id, seq, step, wire)
    SELECT e.session_id, e.seq,
           jsonb_strip_nulls(jsonb_build_object('id', 'tape:' || t.tape_seq, 'api', t.api, 'provider', t.provider,
                                                'model', t.model, 'stopReason', t.stop_reason, 'index', t.idx)),
           NULLIF(
             COALESCE((SELECT jsonb_object_agg(f.key, f.value::jsonb) FROM json_each(t.blk) f
                        WHERE f.key <> ALL (CASE t.blk ->> 'type'
                                              WHEN 'toolCall' THEN ARRAY['type', 'id', 'name', 'arguments']
                                              WHEN 'thinking' THEN ARRAY['type', 'thinking', 'thinkingSignature']
                                              ELSE ARRAY['type', 'text'] END)), '{}'::jsonb)
             || CASE WHEN e.type = 'tool_call' THEN
                  jsonb_build_object('argumentsJson', COALESCE((t.blk -> 'arguments')::text, '{}'))
                  || CASE WHEN (t.blk ->> 'name') IS DISTINCT FROM (e.j ->> 'tool')
                          THEN jsonb_build_object('name', t.blk ->> 'name') ELSE '{}'::jsonb END
                ELSE '{}'::jsonb END,
             '{}'::jsonb)
      FROM entries_unique e
      JOIN tape_unique t USING (session_id, key)
     WHERE e.key NOT LIKE 'text:%' OR abs(e.created_at - t.created_at) <= 600000
    ON CONFLICT (session_id, seq) DO NOTHING;
    GET DIAGNOSTICS n_steps = ROW_COUNT;
    PERFORM set_config('enable_nestloop', 'on', true);
    INSERT INTO legacy_turn_runs(session_id, seq, run_id, inferred)
    SELECT e.session_id, e.seq, COALESCE(by_seq.id, by_window.id), by_seq.id IS NULL
      FROM session_entries e
      CROSS JOIN LATERAL (SELECT CASE WHEN octet_length(e.payload) > 16777216 THEN NULL WHEN pg_input_is_valid(e.payload, 'jsonb') THEN e.payload::jsonb END AS j) p
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(*) = 1 THEN min(r.id) END AS id FROM legacy_prep_runs r
         WHERE r.session_id = e.session_id AND r.turn_user_seq = e.seq
      ) by_seq ON true
      LEFT JOIN LATERAL (
        SELECT latest.id FROM (
          SELECT r.id, r.turn_user_seq, r.finished_at, r.prev_max_finished FROM legacy_prep_runs r
           WHERE r.session_id = e.session_id AND r.started_at <= e.created_at
           ORDER BY r.started_at DESC, r.id DESC LIMIT 1
        ) latest
         WHERE latest.turn_user_seq IS NULL AND e.created_at <= latest.finished_at
           AND COALESCE(latest.prev_max_finished, -1) < e.created_at
      ) by_window ON true
     WHERE e.session_id = ANY(ids) AND e.type = 'user' AND e.created_at < frozen_at AND jsonb_typeof(p.j) = 'object'
       AND NOT p.j @> '{"steered":true}' AND NOT p.j @> '{"overheard":true}'
       AND NOT COALESCE(jsonb_typeof(p.j -> 'runId') = 'string' AND p.j ->> 'runId' <> '', false)
       AND COALESCE(by_seq.id, by_window.id) IS NOT NULL
    ON CONFLICT (session_id, seq) DO NOTHING;
    GET DIAGNOSTICS n_turns = ROW_COUNT;
  DROP TABLE pg_temp.legacy_batch_blocks;
END $batch$`,
      `CREATE OR REPLACE PROCEDURE prepare_legacy_tape_steps(batch INT DEFAULT 50)
LANGUAGE plpgsql AS $prepare$
DECLARE
  ids TEXT[];
  frozen_at BIGINT;
  n_invalid BIGINT;
  n_keyed BIGINT;
  n_steps BIGINT;
  n_turns BIGINT;
  n_skipped BIGINT;
  one TEXT;
  counts RECORD;
  last_error TEXT;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('prepare_legacy_tape_steps')) THEN
    RAISE EXCEPTION 'prepare_legacy_tape_steps() is already running in another session';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'legacy_tape_frozen' AND tgrelid = 'session_tape'::regclass) THEN
    IF EXISTS (SELECT 1 FROM legacy_tape_steps_progress WHERE started_at IS NOT NULL OR last_session IS NOT NULL OR done) THEN
      RAISE EXCEPTION 'legacy_tape_frozen is gone but a preparation already started: reset legacy_tape_steps_progress, legacy_tape_steps, legacy_turn_runs, legacy_tape_writes and legacy_tape_skipped before starting again';
    END IF;
    PERFORM set_config('lock_timeout', '5s', true);
    CREATE TRIGGER legacy_tape_frozen AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON session_tape
      FOR EACH STATEMENT EXECUTE FUNCTION legacy_tape_written();
    ALTER TABLE session_tape ENABLE ALWAYS TRIGGER legacy_tape_frozen;
    UPDATE legacy_tape_steps_progress SET started_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
    COMMIT;
  END IF;
  SELECT started_at INTO frozen_at FROM legacy_tape_steps_progress;
  IF to_regclass('legacy_prep_runs') IS NULL THEN
    CREATE TABLE legacy_prep_runs(
      id TEXT, session_id TEXT, turn_user_seq BIGINT, started_at BIGINT, finished_at BIGINT, prev_max_finished BIGINT
    );
    IF to_regclass('runs') IS NOT NULL THEN
      INSERT INTO legacy_prep_runs
        SELECT r.id, s.id, r.turn_user_seq, r.started_at, r.finished_at,
               max(COALESCE(r.finished_at, 9223372036854775807)) OVER (
                 PARTITION BY s.id ORDER BY r.started_at, r.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
          FROM runs r JOIN sessions s ON s.thread_ref = r.session_id
         WHERE r.started_at IS NOT NULL;
    END IF;
    CREATE INDEX legacy_prep_runs_by_seq ON legacy_prep_runs(session_id, turn_user_seq);
    CREATE INDEX legacy_prep_runs_by_start ON legacy_prep_runs(session_id, started_at DESC, id DESC);
    COMMIT;
  END IF;
  LOOP
    SELECT array_agg(id ORDER BY id) INTO ids
      FROM (SELECT id FROM sessions
             WHERE id > COALESCE((SELECT last_session FROM legacy_tape_steps_progress), '')
             ORDER BY id LIMIT batch) next_sessions;
    EXIT WHEN ids IS NULL;
    BEGIN
      SELECT * INTO n_invalid, n_keyed, n_steps, n_turns FROM legacy_tape_steps_batch(ids, frozen_at);
      n_skipped := 0;
    EXCEPTION WHEN OTHERS THEN
      IF left(SQLSTATE, 2) IN ('40', '42', '53', '55', '57', '58') THEN
        RAISE;
      END IF;
      n_invalid := 0; n_keyed := 0; n_steps := 0; n_turns := 0; n_skipped := 0;
      FOREACH one IN ARRAY ids LOOP
        BEGIN
          SELECT * INTO counts FROM legacy_tape_steps_batch(ARRAY[one], frozen_at);
          n_invalid := n_invalid + counts.n_invalid; n_keyed := n_keyed + counts.n_keyed;
          n_steps := n_steps + counts.n_steps; n_turns := n_turns + counts.n_turns;
        EXCEPTION WHEN OTHERS THEN
          IF left(SQLSTATE, 2) IN ('40', '42', '53', '55', '57', '58') THEN
            RAISE;
          END IF;
          last_error := SQLSTATE || ': ' || SQLERRM;
          INSERT INTO legacy_tape_skipped VALUES (one, last_error, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
            ON CONFLICT (session_id) DO UPDATE SET error = EXCLUDED.error, at = EXCLUDED.at;
          n_skipped := n_skipped + 1;
        END;
      END LOOP;
      IF n_skipped > 0 AND (SELECT skipped_sessions FROM legacy_tape_steps_progress) + n_skipped > 100 THEN
        RAISE EXCEPTION 'more than 100 sessions could not be prepared, so the failure is unlikely to be in the data: %', last_error;
      END IF;
      IF array_length(ids, 1) > 1 AND n_skipped = array_length(ids, 1) THEN
        RAISE EXCEPTION 'every session in the batch after % failed, so the failure is not in the data: %',
          COALESCE((SELECT last_session FROM legacy_tape_steps_progress), '(start)'), last_error;
      END IF;
    END;
    UPDATE legacy_tape_steps_progress
       SET last_session = ids[array_length(ids, 1)],
           invalid_messages = invalid_messages + n_invalid, keyed_blocks = keyed_blocks + n_keyed,
           copied_steps = copied_steps + n_steps, copied_turns = copied_turns + n_turns,
           skipped_sessions = skipped_sessions + n_skipped;
    COMMIT;
  END LOOP;
  DROP TABLE legacy_prep_runs;
  UPDATE legacy_tape_steps_progress SET done = true;
  COMMIT;
  PERFORM pg_advisory_unlock(hashtext('prepare_legacy_tape_steps'));
END $prepare$`,
    ],
  },
  {
    id: "sessions/store/0031-drop-session-tape",
    expectedChecksum: "3100b33fe1e55d5abe05f50b655f3ff73142e3608af3616ba4954209b5f42e5b",
    prepare: [
      `DO $prepare_tape_drop$
BEGIN
  IF to_regclass('session_tape') IS NULL OR (SELECT done FROM legacy_tape_steps_progress) THEN
    RETURN;
  END IF;
  IF (SELECT started_at FROM legacy_tape_steps_progress) IS NULL THEN
    DELETE FROM session_tape t WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = t.session_id);
  END IF;
  IF EXISTS (SELECT 1 FROM session_tape WHERE kind = 'message') THEN
    CALL prepare_legacy_tape_steps(50);
  END IF;
END $prepare_tape_drop$`,
    ],
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `DO $tape_drop_gate$
DECLARE
  started BIGINT;
  finished BOOLEAN;
  cursor_at TEXT;
  skipped BIGINT;
  last_tape_session TEXT;
  writes BIGINT;
  first_write BIGINT;
  reset TEXT := 'reset with DROP TRIGGER legacy_tape_frozen ON session_tape; TRUNCATE legacy_tape_steps, legacy_turn_runs, legacy_tape_writes, legacy_tape_skipped; '
    || 'UPDATE legacy_tape_steps_progress SET started_at = NULL, last_session = NULL, done = false, invalid_messages = 0, '
    || 'keyed_blocks = 0, copied_steps = 0, copied_turns = 0, skipped_sessions = 0; then CALL prepare_legacy_tape_steps() again';
BEGIN
  IF to_regclass('session_tape') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE session_tape IN ACCESS EXCLUSIVE MODE;
  IF to_regclass('legacy_tape_steps_progress') IS NOT NULL THEN
    SELECT started_at, done, last_session, skipped_sessions INTO started, finished, cursor_at, skipped
      FROM legacy_tape_steps_progress;
  END IF;
  IF started IS NULL OR NOT COALESCE(finished, false) THEN
    IF NOT EXISTS (SELECT 1 FROM session_tape WHERE kind = 'message') THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'session_tape still holds model messages: run CALL prepare_legacy_tape_steps() to completion before this migration, or if legacy_tape_frozen already exists, %',
      reset;
  END IF;
  skipped := GREATEST(skipped, (SELECT count(*) FROM legacy_tape_skipped));
  IF skipped > 100 THEN
    RAISE EXCEPTION '% sessions were skipped during the preparation, more than 100: review legacy_tape_skipped, then %',
      skipped, reset;
  END IF;
  SELECT max(session_id) INTO last_tape_session FROM session_tape WHERE kind = 'message';
  IF cursor_at IS NULL OR cursor_at < last_tape_session THEN
    RAISE EXCEPTION 'the preparation is marked done but its cursor % is before the last tape session %, so not every session was copied: %',
      COALESCE(cursor_at, '(none)'), last_tape_session, reset;
  END IF;
  SELECT count(*), min(at) INTO writes, first_write FROM legacy_tape_writes;
  IF writes > 0 THEN
    RAISE EXCEPTION 'session_tape was written % times after prepare_legacy_tape_steps() started, first at % (ms since epoch): stop every writer, %',
      writes, first_write, reset;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'legacy_tape_frozen' AND tgrelid = 'session_tape'::regclass AND tgenabled = 'A'
  ) THEN
    RAISE EXCEPTION 'legacy_tape_frozen is missing or not always enabled, so tape writes since the preparation are unproven: %', reset;
  END IF;
END $tape_drop_gate$`,
      `DROP VIEW IF EXISTS session_transcript_entries`,
      `DROP TABLE IF EXISTS session_tape`,
      `DROP PROCEDURE IF EXISTS prepare_legacy_tape_steps(INT)`,
      `DROP FUNCTION IF EXISTS legacy_tape_written()`,
      `DROP FUNCTION IF EXISTS legacy_tape_steps_batch(TEXT[], BIGINT)`,
      `DROP TABLE IF EXISTS legacy_prep_runs, legacy_tape_writes`,
    ],
  },
];

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
