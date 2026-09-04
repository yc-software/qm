import { createPostgresEventSink, type EventColumn } from "./scoped-event-sink.ts";
import type { CredentialUsageSample, CredentialUsageSink } from "./credential-usage-sink.ts";

const COLUMNS: readonly EventColumn<keyof CredentialUsageSample & string>[] = [
  ["ts", "ts", "BIGINT", "number", true],
  ["slug", "slug", "TEXT", "string", true],
  ["host", "host", "TEXT", "string", true],
  ["status", "status", "TEXT", "string", true],
  ["upstream_status", "upstreamStatus", "INT", "number"],
  ["scope_label", "scopeLabel", "TEXT", "string", true],
  ["principal_id", "principalId", "TEXT", "string", true],
];

export function createPostgresCredentialUsageSink(connectionString: string): CredentialUsageSink {
  return createPostgresEventSink<CredentialUsageSample>({
    connectionString,
    table: "credential_usage",
    columns: COLUMNS,
    defaultLimit: 5000,
    equalityFilters: { scopeId: "scope_label", slug: "slug" },
    persistErrorMessage: "[credential-usage] failed to persist broker call:",
  });
}
