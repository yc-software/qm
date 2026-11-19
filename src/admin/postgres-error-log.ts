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

    defaultLimit: 200,
    equalityFilters: { scopeId: "scope_label", sessionId: "session_id" },
    persistErrorMessage: "[errors] failed to persist error event:",
  });
}
