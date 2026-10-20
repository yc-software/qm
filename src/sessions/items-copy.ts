export const ITEMS_COPY_REPAIR_SQL = [
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
];

export interface ItemsCopyOptions {
  delta?: boolean;
  bucket?: { index: number; count: number };
}

const bucketPredicate = (col: string, bucket: { index: number; count: number }): string => {
  const { index, count } = bucket;
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count)
    throw new Error(`items copy: bucket ${index} of ${count} is invalid`);
  return `((hashtextextended(${col}, 0) % ${count}) + ${count}) % ${count} = ${index}`;
};

const TENANT = `(SELECT id FROM qm_tenant)`;
const AUTHOR_KINDS_SQL = `('UserMessage', 'SteeringMessage', 'ElicitationResponse', 'Stop')`;

const str = (key: string): string =>
  `CASE WHEN jsonb_typeof(n.body -> '${key}') = 'string' THEN n.body ->> '${key}' END`;
const isType = (key: string, type: string): string => `jsonb_typeof(n.body -> '${key}') = '${type}'`;

const NORMALIZE = `  CROSS JOIN LATERAL (SELECT items_copy_payload(e.payload) AS j OFFSET 0) parsed
  CROSS JOIN LATERAL (
    SELECT CASE WHEN parsed.j IS NULL OR jsonb_typeof(parsed.j) = 'null' THEN '{}'::jsonb
                WHEN jsonb_typeof(parsed.j) = 'object' THEN parsed.j
                WHEN jsonb_typeof(parsed.j) = 'string' THEN jsonb_build_object('text', parsed.j)
                ELSE jsonb_build_object('value', parsed.j)
           END AS body
    OFFSET 0
  ) n
`;

function ambiguousCallsSql(selected: boolean): string {
  return `SELECT DISTINCT session_id, call_id FROM (
    SELECT e.session_id, e.type, n.body ->> 'callId' AS call_id
    FROM session_entries e
    ${NORMALIZE}
    WHERE e.type IN ('tool_call', 'tool_result')
      ${selected ? "AND e.session_id IN (SELECT DISTINCT session_id FROM pg_temp.items_copy_batch)" : ""}
      AND jsonb_typeof(n.body -> 'callId') = 'string'
      AND octet_length(n.body ->> 'callId') BETWEEN 1 AND 1024
    GROUP BY e.session_id, e.type, n.body ->> 'callId'
    HAVING count(*) > 1
  ) repeated`;
}

const CALL_IDS = `  LEFT JOIN ambiguous_calls ambiguous
    ON ambiguous.session_id=e.session_id AND ambiguous.call_id=n.body ->> 'callId'
`;

const KIND = `  CROSS JOIN LATERAL (
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
`;

const HOIST = `  LEFT JOIN legacy_tape_steps l ON l.session_id = e.session_id AND l.seq = e.seq
  CROSS JOIN LATERAL (
    SELECT CASE WHEN k.kind IN ('UserMessage', 'SteeringMessage', 'AgentMessage', 'ContextCompaction') THEN 'text'
                WHEN k.kind = 'Reasoning' THEN 'thinking'
                WHEN k.kind = 'ToolResult' THEN 'result'
                WHEN k.kind = 'Error' THEN 'message'
           END AS text_key,
           CASE WHEN k.kind IN ('ToolCall', 'ToolResult', 'Reasoning', 'AgentMessage') THEN
             COALESCE(CASE WHEN ${isType("step", "object")} THEN n.body -> 'step' END, l.step) END AS step_obj,
           pg_input_is_valid(n.body ->> 'runId', 'uuid') AS run_is_uuid
  ) t
  CROSS JOIN LATERAL (
    SELECT CASE WHEN jsonb_typeof(n.body -> t.text_key) = 'string' THEN t.text_key END AS text_key,
           CASE WHEN jsonb_typeof(t.step_obj -> 'index') = 'number' THEN (t.step_obj ->> 'index')::int END AS step,
           CASE WHEN t.step_obj IS NOT NULL
                THEN COALESCE(CASE WHEN ${isType("wire", "object")} THEN n.body -> 'wire' END, l.wire, '{}'::jsonb)
                     || jsonb_build_object('message', t.step_obj - 'index')
                WHEN NOT n.body ? 'wire' AND l.wire IS NOT NULL THEN l.wire
           END AS wire
  ) s
  CROSS JOIN LATERAL (
    SELECT CASE WHEN k.kind IN ${AUTHOR_KINDS_SQL} AND n.body ->> 'sourceRole' IS DISTINCT FROM 'agent' THEN
             COALESCE(
               CASE WHEN NOT n.body @> '{"overheard":true}' THEN
                 (SELECT min(p.principal_id) FROM participants p
                   WHERE p.session_id = e.session_id AND p.valid_from <= e.created_at
                     AND (p.valid_to IS NULL OR p.valid_to > e.created_at)
                  HAVING count(*) = 1) END,
               CASE WHEN btrim(${str("name")}) <> '' THEN
                 (SELECT min(p.principal_id) FROM participants p
                   WHERE p.session_id = e.session_id
                     AND EXISTS (SELECT 1 FROM directory_members d
                                  WHERE d.principal_id = p.principal_id
                                    AND d.display_name_lc = lower(btrim(n.body ->> 'name')))
                  HAVING count(*) = 1) END)
           END AS author,
           CASE WHEN k.kind = 'Retraction' AND ${isType("ts", "string")} THEN
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
             CASE WHEN k.kind = 'ToolResult' AND ${isType("isError", "boolean")} THEN 'isError' END,
             CASE WHEN k.kind = 'UserMessage' AND ${isType("hidden", "boolean")} THEN 'hidden' END,
             CASE WHEN k.kind = 'UserMessage' AND ${isType("ts", "string")} THEN 'ts' END,
             CASE WHEN e.type = 'user' THEN 'steered' END,
             CASE WHEN k.kind = 'ContextCompaction' AND ${isType("throughSeq", "number")} THEN 'throughSeq' END,
             CASE WHEN k.kind = 'ElicitationResponse' AND ${isType("approved", "boolean")} THEN 'approved' END,
             CASE WHEN e.type = 'system' AND n.body ->> 'kind' <> 'goal_cancelled' THEN 'kind' END,
             CASE WHEN k.kind = 'Wake' THEN 'cause' END,
             CASE WHEN t.run_is_uuid THEN 'runId' END,
             CASE WHEN t.step_obj IS NOT NULL THEN 'step' END,
             CASE WHEN s.wire IS NOT NULL THEN 'wire' END,
             CASE WHEN s.text_key = 'result' AND ${isType("stdout", "string")}
                       AND strpos(n.body ->> 'result', n.body ->> 'stdout') > 0 THEN 'stdout' END,
             CASE WHEN s.text_key = 'result' AND ${isType("stderr", "string")}
                       AND strpos(n.body ->> 'result', n.body ->> 'stderr') > 0 THEN 'stderr' END
           ]::text[], NULL)
           || CASE WHEN s.wire IS NOT NULL THEN jsonb_build_object('wire', s.wire) ELSE '{}'::jsonb END AS body
  ) x
`;

const COLUMNS = `tenant_id, session_id, seq, turn_id, kind, author, call_id, elicit_id, wake_cause, error_code,
                   text, tool, step, variant, is_error, hidden, external_id, through_seq, target_seq, approved,
                   body, created_at`;

const SELECT = `SELECT ${TENANT}, e.session_id, e.seq,
       CASE WHEN t.run_is_uuid THEN (n.body ->> 'runId')::uuid END,
       k.kind,
       a.author,
       CASE WHEN k.kind IN ('ToolCall', 'ToolResult') AND octet_length(${str("callId")}) <= 1024 AND ambiguous.call_id IS NULL
            THEN NULLIF(${str("callId")}, '') END,
       CASE WHEN k.kind IN ('Elicitation', 'ElicitationResponse') THEN
         COALESCE(NULLIF(${str("requestId")}, ''), 'missing-elicit:' || e.seq) END,
       CASE WHEN k.kind = 'Wake' THEN
         CASE WHEN n.body ? 'cause' THEN (n.body ->> 'cause')::wake_cause ELSE 'system'::wake_cause END END,
       CASE WHEN k.kind = 'Error' THEN 'turn_failure' END,
       NULLIF(n.body ->> s.text_key, ''),
       CASE WHEN k.kind IN ('ToolCall', 'ToolResult') THEN NULLIF(${str("tool")}, '') END,
       s.step,
       CASE e.type WHEN 'text' THEN 'narration' WHEN 'delivery' THEN 'files_delivered' END,
       CASE WHEN k.kind = 'ToolResult' AND ${isType("isError", "boolean")} THEN (n.body -> 'isError')::boolean END,
       CASE WHEN k.kind = 'UserMessage' AND ${isType("hidden", "boolean")} THEN (n.body -> 'hidden')::boolean END,
       CASE WHEN k.kind = 'UserMessage' THEN NULLIF(${str("ts")}, '') END,
       CASE WHEN k.kind = 'ContextCompaction' AND ${isType("throughSeq", "number")} THEN (n.body ->> 'throughSeq')::numeric::bigint END,
       a.target_seq,
       CASE WHEN k.kind = 'ElicitationResponse' AND ${isType("approved", "boolean")} THEN (n.body -> 'approved')::boolean END,
       x.body,
       to_timestamp(e.created_at / 1000.0)`;

export function itemsCopySql(opts: ItemsCopyOptions = {}): string {
  const from = opts.delta
    ? `  FROM sessions sess
  CROSS JOIN LATERAL (
    SELECT COALESCE(max(i.seq), -1) AS seq FROM items i WHERE i.tenant_id = ${TENANT} AND i.session_id = sess.id
  ) copied
  CROSS JOIN LATERAL (
    SELECT * FROM session_entries d WHERE d.session_id = sess.id AND d.seq > copied.seq OFFSET 0
  ) e
`
    : `  FROM session_entries e
`;
  const bucket = opts.bucket ? `${bucketPredicate(opts.delta ? "sess.id" : "e.session_id", opts.bucket)}\n   AND ` : "";
  return insertRows(`WITH ambiguous_calls AS MATERIALIZED (${ambiguousCallsSql(false)})
${SELECT}
${from}${NORMALIZE}${KIND}${CALL_IDS}${HOIST} WHERE ${bucket}k.kind IS NOT NULL`);
}

function insertRows(rows: string): string {
  return `WITH inserted AS (
    INSERT INTO items(${COLUMNS}) ${rows} RETURNING kind,author
  ) SELECT count(*)::int AS rows,
           count(*) FILTER (WHERE kind IN ${AUTHOR_KINDS_SQL})::int AS author_eligible,
           count(*) FILTER (WHERE kind IN ${AUTHOR_KINDS_SQL} AND author IS NULL)::int AS author_null
      FROM inserted`;
}

export function itemsSelectedRowsSql(): string {
  return `WITH ambiguous_calls AS MATERIALIZED (${ambiguousCallsSql(true)})
  SELECT * FROM (
    ${SELECT}
    FROM pg_temp.items_copy_batch b
    JOIN session_entries e ON (e.session_id,e.seq)=(b.session_id,b.seq)
    ${NORMALIZE}${KIND}${CALL_IDS}${HOIST} WHERE k.kind IS NOT NULL
  ) AS mapped(${COLUMNS})`;
}

export function itemsCopySelectedSql(): string {
  return insertRows(itemsSelectedRowsSql());
}
