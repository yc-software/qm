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

    schema: {
      expectedChecksum: "42188c2f50734398496ddd5a47a9ec3c15a507059c713a4a6ced0b0b81d908eb",
      followUps: [
        {
          id: "admin/scoped-events/credential_usage/0002",
          statements: [
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS credential_usage_by_slug_ts_id ON credential_usage(slug, ts DESC, id DESC)",
          ],
        },
      ],
    },
    defaultLimit: 5000,
    equalityFilters: { scopeId: "scope_label", slug: "slug" },
    persistErrorMessage: "[credential-usage] failed to persist broker call:",
  });
}
