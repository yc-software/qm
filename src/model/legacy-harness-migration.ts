const LEGACY = "('codex', 'opencode')";

function guarded(columns: readonly [table: string, column: string][], statements: readonly string[]): string {
  const present = columns
    .map(
      ([table, column]) =>
        `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = '${column}')`,
    )
    .join(" AND ");
  return `DO $$ BEGIN IF ${present} THEN ${statements.join("; ")}; END IF; END $$`;
}

function jsonRuntime(table: string, path: string): string {
  return `UPDATE ${table} SET json = jsonb_set(json, '{${path}}', '"pi"') WHERE json #>> '{${path}}' IN ${LEGACY}`;
}

function textRuntime(table: string, column: string, path: string, extra = ""): string {
  return `UPDATE ${table} SET ${column} = jsonb_set(${column}::jsonb, '{${path}}', '"pi"')::text WHERE ${extra}CASE WHEN ${column} LIKE '%"${path}"%' THEN ${column}::jsonb #>> '{${path}}' IN ${LEGACY} ELSE false END`;
}

export const LEGACY_HARNESS_MIGRATION = {
  id: "runtime/0001-legacy-harnesses-to-pi",
  statements: [
    guarded(
      [["base_model_configs", "json"]],
      ["harnessId", "cronRuntime,harnessId", "subagentRuntime,harnessId", "fallbackRuntime,harnessId"].map((path) =>
        jsonRuntime("base_model_configs", path),
      ),
    ),
    guarded(
      [["approved_harness_configs", "json"]],
      [
        `UPDATE approved_harness_configs SET json = jsonb_set(json, '{ids}', (SELECT COALESCE(jsonb_agg(to_jsonb(id) ORDER BY first), '[]'::jsonb) FROM (SELECT CASE WHEN value IN ${LEGACY} THEN 'pi' ELSE value END AS id, min(ordinality) AS first FROM jsonb_array_elements_text(json -> 'ids') WITH ORDINALITY GROUP BY 1) ids)) WHERE jsonb_typeof(json -> 'ids') = 'array' AND json -> 'ids' ?| array['codex', 'opencode']`,
      ],
    ),
    guarded([["auto_flagger_configs", "json"]], [jsonRuntime("auto_flagger_configs", "harnessId")]),
    guarded([["crons", "json"]], [jsonRuntime("crons", "runtime,harnessId")]),
    guarded([["swarms", "json"]], [jsonRuntime("swarms", "template,harness")]),
    guarded([["sessions", "spawn_meta"]], [textRuntime("sessions", "spawn_meta", "harness")]),
    guarded(
      [
        ["runs", "request"],
        ["runs", "status"],
      ],
      [textRuntime("runs", "request", "harness", "status IN ('pending', 'running') AND ")],
    ),
    guarded(
      [
        ["session_entries", "payload"],
        ["sessions", "thread_ref"],
        ["runs", "status"],
      ],
      [
        `UPDATE session_entries e SET payload = jsonb_set(e.payload::jsonb, '{runtimeHandoff,choice,harnessId}', '"pi"')::text FROM runs r JOIN sessions s ON s.thread_ref = r.session_id WHERE r.status IN ('pending', 'running') AND e.session_id = s.id AND e.type = 'tool_result' AND CASE WHEN e.payload LIKE '%"runtimeHandoff"%' THEN e.payload::jsonb ->> 'runId' = r.id AND e.payload::jsonb #>> '{runtimeHandoff,choice,harnessId}' IN ${LEGACY} ELSE false END`,
      ],
    ),
  ],
};
