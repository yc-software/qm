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
    tape_written BOOLEAN NOT NULL DEFAULT false
  )`,
  `INSERT INTO legacy_tape_steps_progress DEFAULT VALUES ON CONFLICT (singleton) DO NOTHING`,
  `CREATE OR REPLACE FUNCTION legacy_tape_written() RETURNS trigger LANGUAGE plpgsql AS $written$
BEGIN
  UPDATE legacy_tape_steps_progress SET tape_written = true WHERE NOT tape_written;
  RETURN NULL;
END $written$`,
  `CREATE OR REPLACE PROCEDURE prepare_legacy_tape_steps(batch INT DEFAULT 200)
LANGUAGE plpgsql AS $prepare$
DECLARE ids TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'legacy_tape_frozen' AND tgrelid = 'session_tape'::regclass) THEN
    UPDATE legacy_tape_steps_progress
       SET started_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint, tape_written = false;
    CREATE TRIGGER legacy_tape_frozen AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON session_tape
      FOR EACH STATEMENT EXECUTE FUNCTION legacy_tape_written();
    COMMIT;
  END IF;
  IF to_regclass('legacy_prep_runs') IS NULL THEN
    CREATE TABLE legacy_prep_runs(id TEXT, session_id TEXT, turn_user_seq BIGINT, started_at BIGINT, finished_at BIGINT);
    IF to_regclass('runs') IS NOT NULL THEN
      INSERT INTO legacy_prep_runs
        SELECT r.id, s.id, r.turn_user_seq, r.started_at, r.finished_at
          FROM runs r JOIN sessions s ON s.thread_ref = r.session_id;
    END IF;
    CREATE INDEX legacy_prep_runs_by_session ON legacy_prep_runs(session_id);
    COMMIT;
  END IF;
  LOOP
    SELECT array_agg(id ORDER BY id) INTO ids
      FROM (SELECT id FROM sessions
             WHERE id > COALESCE((SELECT last_session FROM legacy_tape_steps_progress), '')
             ORDER BY id LIMIT batch) next_sessions;
    EXIT WHEN ids IS NULL;
    WITH blocks AS (
      SELECT t.session_id, t.seq AS tape_seq, m.msg, b.blk, (b.ord - 1)::int AS idx
        FROM session_tape t
        CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(t.payload, 'json') THEN t.payload::json END AS msg) m
        CROSS JOIN LATERAL json_array_elements(
          CASE WHEN json_typeof(m.msg -> 'content') = 'array' THEN m.msg -> 'content' ELSE '[]'::json END
        ) WITH ORDINALITY AS b(blk, ord)
       WHERE t.session_id = ANY(ids) AND t.kind = 'message' AND m.msg ->> 'role' = 'assistant'
    ), keyed AS (
      SELECT blocks.*,
             CASE blk ->> 'type'
               WHEN 'toolCall' THEN 'call:' || (blk ->> 'id')
               WHEN 'thinking' THEN CASE WHEN COALESCE(blk ->> 'thinkingSignature', '') <> ''
                                         THEN 'sig:' || (blk ->> 'thinkingSignature') END
               WHEN 'text' THEN 'text:' || (blk ->> 'text')
             END AS key
        FROM blocks
    ), tape_unique AS (
      SELECT * FROM (SELECT keyed.*, count(*) OVER (PARTITION BY session_id, key) AS n FROM keyed WHERE key IS NOT NULL) k
       WHERE n = 1
    ), entries AS (
      SELECT e.session_id, e.seq, e.type,
             CASE WHEN e.type = 'tool_call' THEN 'call:' || (p.j ->> 'callId')
                  WHEN e.type = 'thinking' THEN 'sig:' || (p.j ->> 'thinkingSignature')
                  ELSE 'text:' || (p.j ->> 'text') END AS key
        FROM session_entries e
        CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(e.payload, 'jsonb') THEN e.payload::jsonb END AS j) p
       WHERE e.session_id IN (SELECT DISTINCT session_id FROM tape_unique)
         AND e.type IN ('tool_call', 'thinking', 'text', 'assistant')
         AND jsonb_typeof(p.j) = 'object' AND NOT p.j ? 'step'
    ), entries_unique AS (
      SELECT * FROM (SELECT entries.*, count(*) OVER (PARTITION BY session_id, key) AS n FROM entries WHERE key IS NOT NULL) x
       WHERE n = 1
    )
    INSERT INTO legacy_tape_steps(session_id, seq, step, wire)
    SELECT e.session_id, e.seq,
           jsonb_build_object('id', 'tape:' || t.tape_seq, 'api', t.msg ->> 'api', 'provider', t.msg ->> 'provider',
                              'model', t.msg ->> 'model', 'stopReason', t.msg ->> 'stopReason', 'index', t.idx),
           CASE WHEN e.type = 'tool_call' THEN
             COALESCE((SELECT jsonb_object_agg(f.key, f.value::jsonb) FROM json_each(t.blk) f
                        WHERE f.key NOT IN ('type', 'id', 'name', 'arguments')), '{}'::jsonb)
             || jsonb_build_object('argumentsJson', COALESCE((t.blk -> 'arguments')::text, '{}'))
           END
      FROM entries_unique e
      JOIN tape_unique t ON t.session_id = e.session_id AND t.key = e.key
    ON CONFLICT (session_id, seq) DO NOTHING;
    INSERT INTO legacy_turn_runs(session_id, seq, run_id, inferred)
    SELECT e.session_id, e.seq, COALESCE(by_seq.id, by_window.id), by_seq.id IS NULL
      FROM session_entries e
      CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(e.payload, 'jsonb') THEN e.payload::jsonb END AS j) p
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(*) = 1 THEN min(r.id) END AS id FROM legacy_prep_runs r
         WHERE r.session_id = e.session_id AND r.turn_user_seq = e.seq
      ) by_seq ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(*) = 1 THEN min(r.id) END AS id FROM legacy_prep_runs r
         WHERE r.session_id = e.session_id AND r.started_at <= e.created_at
           AND e.created_at <= COALESCE(r.finished_at, 9223372036854775807)
      ) by_window ON true
     WHERE e.session_id = ANY(ids) AND e.type = 'user' AND jsonb_typeof(p.j) = 'object'
       AND NOT p.j @> '{"steered":true}' AND NOT p.j @> '{"overheard":true}'
       AND NOT COALESCE(jsonb_typeof(p.j -> 'runId') = 'string' AND p.j ->> 'runId' <> '', false)
       AND COALESCE(by_seq.id, by_window.id) IS NOT NULL
    ON CONFLICT (session_id, seq) DO NOTHING;
    UPDATE legacy_tape_steps_progress SET last_session = ids[array_length(ids, 1)];
    COMMIT;
  END LOOP;
  DROP TABLE legacy_prep_runs;
  UPDATE legacy_tape_steps_progress SET done = true;
  COMMIT;
END $prepare$`,
];
