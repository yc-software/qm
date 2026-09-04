import { createPostgresEventSink, type EventColumn } from "./scoped-event-sink.ts";
import type { ErrorEvent, ErrorLog } from "./error-log.ts";

const COLUMNS: readonly EventColumn<keyof ErrorEvent & string>[] = [
  ["ts", "ts", "BIGINT", "number", true],
  ["scope_label", "scopeLabel", "TEXT", "string", true],
  ["category", "category", "TEXT", "string", true],
  ["code", "code", "TEXT", "string", true],
  ["message", "message", "TEXT", "string", true],
  ["session_id", "sessionId", "TEXT", "string"],
];

export function createPostgresErrorLog(connectionString: string): ErrorLog {
  return createPostgresEventSink<ErrorEvent>({
    connectionString,
    table: "error_events",
    columns: COLUMNS,
    extraSchemaStatements: [
      "CREATE INDEX IF NOT EXISTS error_events_by_ts ON error_events(ts DESC)",
      "CREATE INDEX IF NOT EXISTS error_events_by_scope_ts ON error_events(scope_label, ts DESC)",
      "CREATE INDEX IF NOT EXISTS error_events_by_session_ts ON error_events(session_id, ts DESC)",
    ],
    defaultLimit: 200,
    equalityFilters: { scopeId: "scope_label", sessionId: "session_id" },
    persistErrorMessage: "[errors] failed to persist error event:",
  });
}
