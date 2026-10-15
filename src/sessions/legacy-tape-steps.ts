const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

function batchSql(sizeGuard: boolean): string {
  const tapeValid = sizeGuard
    ? `CASE WHEN octet_length(t.payload) > ${MAX_PAYLOAD_BYTES} THEN false
                        ELSE pg_input_is_valid(t.payload, 'jsonb') AND left(btrim(t.payload), 1) = '{' END`
    : `pg_input_is_valid(t.payload, 'jsonb') AND left(btrim(t.payload), 1) = '{'`;
  const entryJson = sizeGuard
    ? `WHEN octet_length(e.payload) > ${MAX_PAYLOAD_BYTES} THEN NULL WHEN pg_input_is_valid(e.payload, 'jsonb') THEN e.payload::jsonb`
    : `WHEN pg_input_is_valid(e.payload, 'jsonb') THEN e.payload::jsonb`;
  return `    PERFORM set_config('enable_nestloop', 'off', true);
    CREATE TEMP TABLE legacy_batch_blocks ON COMMIT DROP AS
      WITH messages AS MATERIALIZED (
        SELECT t.session_id, t.seq, t.created_at, v.valid, m.*
          FROM session_tape t
          CROSS JOIN LATERAL (
            SELECT ${tapeValid} AS valid OFFSET 0
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
        CROSS JOIN LATERAL (SELECT CASE ${entryJson} END AS j) p
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
      CROSS JOIN LATERAL (SELECT CASE ${entryJson} END AS j) p
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
`;
}

const PREPARE_HEAD = `CREATE OR REPLACE PROCEDURE prepare_legacy_tape_steps(batch INT DEFAULT 50)
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
`;

const PREPARE_TAIL = `    UPDATE legacy_tape_steps_progress
       SET last_session = ids[array_length(ids, 1)],
           invalid_messages = invalid_messages + n_invalid, keyed_blocks = keyed_blocks + n_keyed,
           copied_steps = copied_steps + n_steps, copied_turns = copied_turns + n_turns;
    COMMIT;
  END LOOP;
  DROP TABLE legacy_prep_runs;
  UPDATE legacy_tape_steps_progress SET done = true;
  COMMIT;
  PERFORM pg_advisory_unlock(hashtext('prepare_legacy_tape_steps'));
END $prepare$`;

const SYSTEM_ERROR_CLASSES = "'40', '42', '53', '55', '57', '58'";

const MAX_SKIPPED_SESSIONS = 100;

const SKIPPING_LOOP = `    BEGIN
      SELECT * INTO n_invalid, n_keyed, n_steps, n_turns FROM legacy_tape_steps_batch(ids, frozen_at);
      n_skipped := 0;
    EXCEPTION WHEN OTHERS THEN
      IF left(SQLSTATE, 2) IN (${SYSTEM_ERROR_CLASSES}) THEN
        RAISE;
      END IF;
      n_invalid := 0; n_keyed := 0; n_steps := 0; n_turns := 0; n_skipped := 0;
      FOREACH one IN ARRAY ids LOOP
        BEGIN
          SELECT * INTO counts FROM legacy_tape_steps_batch(ARRAY[one], frozen_at);
          n_invalid := n_invalid + counts.n_invalid; n_keyed := n_keyed + counts.n_keyed;
          n_steps := n_steps + counts.n_steps; n_turns := n_turns + counts.n_turns;
        EXCEPTION WHEN OTHERS THEN
          IF left(SQLSTATE, 2) IN (${SYSTEM_ERROR_CLASSES}) THEN
            RAISE;
          END IF;
          last_error := SQLSTATE || ': ' || SQLERRM;
          INSERT INTO legacy_tape_skipped VALUES (one, last_error, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
            ON CONFLICT (session_id) DO UPDATE SET error = EXCLUDED.error, at = EXCLUDED.at;
          n_skipped := n_skipped + 1;
        END;
      END LOOP;
      IF n_skipped > 0 AND (SELECT skipped_sessions FROM legacy_tape_steps_progress) + n_skipped > ${MAX_SKIPPED_SESSIONS} THEN
        RAISE EXCEPTION 'more than ${MAX_SKIPPED_SESSIONS} sessions could not be prepared, so the failure is unlikely to be in the data: %', last_error;
      END IF;
      IF array_length(ids, 1) > 1 AND n_skipped = array_length(ids, 1) THEN
        RAISE EXCEPTION 'every session in the batch after % failed, so the failure is not in the data: %',
          COALESCE((SELECT last_session FROM legacy_tape_steps_progress), '(start)'), last_error;
      END IF;
    END;
`;

function replaceOnce(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`legacy tape steps: expected one ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

const skippingProcedure = () =>
  replaceOnce(
    replaceOnce(
      replaceOnce(
        PREPARE_HEAD + SKIPPING_LOOP + PREPARE_TAIL,
        "  n_turns BIGINT;\n",
        "  n_turns BIGINT;\n  n_skipped BIGINT;\n  one TEXT;\n  counts RECORD;\n  last_error TEXT;\n",
      ),
      "copied_turns = copied_turns + n_turns;",
      "copied_turns = copied_turns + n_turns,\n           skipped_sessions = skipped_sessions + n_skipped;",
    ),
    "legacy_turn_runs and legacy_tape_writes before starting again",
    "legacy_turn_runs, legacy_tape_writes and legacy_tape_skipped before starting again",
  );

export const LEGACY_TAPE_STEPS_SQL = [
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
  PREPARE_HEAD + batchSql(false) + PREPARE_TAIL,
];

export const LEGACY_TAPE_STEPS_SIZE_GUARD_SQL = [
  `ALTER TABLE legacy_tape_steps_progress ADD COLUMN IF NOT EXISTS skipped_sessions BIGINT NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS legacy_tape_skipped(session_id TEXT PRIMARY KEY, error TEXT NOT NULL, at BIGINT NOT NULL)`,
  `CREATE OR REPLACE FUNCTION legacy_tape_steps_batch(
  ids TEXT[], frozen_at BIGINT, OUT n_invalid BIGINT, OUT n_keyed BIGINT, OUT n_steps BIGINT, OUT n_turns BIGINT
) LANGUAGE plpgsql AS $batch$
BEGIN
  IF to_regclass('pg_temp.legacy_batch_blocks') IS NOT NULL THEN
    DROP TABLE pg_temp.legacy_batch_blocks;
  END IF;
${batchSql(true)}  DROP TABLE pg_temp.legacy_batch_blocks;
END $batch$`,
  skippingProcedure(),
];

export const PREPARE_TAPE_DROP_SQL = [
  `DO $prepare_tape_drop$
BEGIN
  IF to_regclass('session_tape') IS NOT NULL
     AND EXISTS (SELECT 1 FROM session_tape WHERE kind = 'message')
     AND NOT (SELECT done FROM legacy_tape_steps_progress) THEN
    IF (SELECT started_at FROM legacy_tape_steps_progress) IS NULL THEN
      DELETE FROM session_tape t WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = t.session_id);
    END IF;
    CALL prepare_legacy_tape_steps(50);
  END IF;
END $prepare_tape_drop$`,
];

export const DROP_SESSION_TAPE_SQL = [
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
  IF skipped > ${MAX_SKIPPED_SESSIONS} THEN
    RAISE EXCEPTION '% sessions were skipped during the preparation, more than ${MAX_SKIPPED_SESSIONS}: review legacy_tape_skipped, then %',
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
];
