import { createPostgresEventSink, type EventColumn } from "./scoped-event-sink.ts";
import type { MetricsSink, TurnMetricSample } from "./metrics-sink.ts";
import { errMessage } from "../util/errors.ts";

const COLUMNS: readonly EventColumn<keyof TurnMetricSample & string>[] = [
  ["ts", "ts", "BIGINT", "number", true],
  ["scope_label", "scopeLabel", "TEXT", "string", true],
  ["session_id", "sessionId", "TEXT", "string"],
  ["turn_seq", "turnSeq", "INT", "number"],
  ["run_id", "runId", "TEXT", "string"],
  ["status", "status", "TEXT", "string", true],
  ["total_ms", "totalMs", "INT", "number", true],
  ["ttft_ms", "ttftMs", "INT", "number"],
  ["intake_preamble_ms", "intakePreambleMs", "INT", "number"],
  ["dispatch_ms", "dispatchMs", "INT", "number"],
  ["provisioned", "provisioned", "BOOLEAN", "boolean"],
  ["cold_start", "coldStart", "BOOLEAN", "boolean"],
  ["model_calls", "modelCalls", "INT", "number"],
  ["tool_calls", "toolCalls", "INT", "number"],
  ["provision_ms", "provisionMs", "INT", "number"],
  ["materialize_ms", "materializeMs", "INT", "number"],
  ["creds_ms", "credsMs", "INT", "number"],
  ["layers_ms", "layersMs", "INT", "number"],
  ["compile_ms", "compileMs", "INT", "number"],
  ["recall_ms", "recallMs", "INT", "number"],
  ["exec_ms", "execMs", "INT", "number"],
  ["stream_ms", "streamMs", "INT", "number"],
  ["lease_ms", "leaseMs", "INT", "number"],
  ["capture_ms", "captureMs", "INT", "number"],
  ["ingress_ms", "ingressMs", "INT", "number"],
  ["detect_ms", "detectMs", "INT", "number"],
  ["compact_ms", "compactMs", "INT", "number"],
  ["queue_ms", "queueMs", "INT", "number"],
  ["deliver_ms", "deliverMs", "INT", "number"],
  ["slack_inflight_ms", "slackInflightMs", "INT", "number"],
  ["resumed_from_seq", "resumedFromSeq", "INT", "number"],
  ["cache_read", "cacheRead", "BIGINT", "number"],
  ["cache_write", "cacheWrite", "BIGINT", "number"],
  ["uncached_input", "uncachedInput", "BIGINT", "number"],
];

const EXTRA_SCHEMA_STATEMENTS = [
  ...COLUMNS.filter(([, , , , required]) => !required).map(
    ([db, , sqlType]) => `ALTER TABLE turn_metrics ADD COLUMN IF NOT EXISTS ${db} ${sqlType}`,
  ),
  "CREATE INDEX IF NOT EXISTS turn_metrics_by_ts ON turn_metrics(ts DESC)",
  "CREATE INDEX IF NOT EXISTS turn_metrics_by_scope_ts ON turn_metrics(scope_label, ts DESC)",
  "CREATE INDEX IF NOT EXISTS turn_metrics_by_session ON turn_metrics(session_id, ts DESC)",
  "CREATE INDEX IF NOT EXISTS turn_metrics_by_run ON turn_metrics(run_id)",
];

export function createPostgresMetricsSink(connectionString: string): MetricsSink {
  const sink = createPostgresEventSink<TurnMetricSample>({
    connectionString,
    table: "turn_metrics",
    columns: COLUMNS,
    extraSchemaStatements: EXTRA_SCHEMA_STATEMENTS,
    defaultLimit: 5000,
    equalityFilters: { scopeId: "scope_label", sessionId: "session_id" },
    persistErrorMessage: "[metrics] failed to persist turn metric:",
  });

  return {
    record: sink.record,
    async updateByRunId(runId, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.deliverMs !== undefined) {
        params.push(patch.deliverMs);
        sets.push(`deliver_ms = $${params.length}`);
      }
      if (patch.slackInflightMs !== undefined) {
        params.push(patch.slackInflightMs);
        sets.push(`slack_inflight_ms = $${params.length}`);
      }
      if (!sets.length) return;
      params.push(runId);
      await sink
        .q(`UPDATE turn_metrics SET ${sets.join(", ")} WHERE run_id = $${params.length}`, params)
        .catch((err) => console.error("[metrics] failed to patch turn metric:", errMessage(err)));
    },
    list: (opts = {}) => sink.list(opts),
  };
}
