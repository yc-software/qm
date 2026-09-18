import { createPostgresEventSink, type EventColumn } from "./scoped-event-sink.ts";
import {
  CREDENTIAL_USAGE_WINDOW,
  type CredentialUsageSample,
  type CredentialUsageSink,
} from "./credential-usage-sink.ts";

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
  const sink = createPostgresEventSink<CredentialUsageSample>({
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
    defaultLimit: CREDENTIAL_USAGE_WINDOW,
    equalityFilters: { scopeId: "scope_label", slug: "slug" },
    persistErrorMessage: "[credential-usage] failed to persist broker call:",
  });
  return {
    ...sink,
    async summary(slugs) {
      if (!slugs.length) return [];
      const rows = await sink.q(
        `SELECT requested.slug, summary.*
         FROM unnest($1::text[]) AS requested(slug)
         CROSS JOIN LATERAL (
           WITH recent AS (
             SELECT id, ts, status, principal_id FROM credential_usage
             WHERE slug = requested.slug ORDER BY ts DESC, id DESC LIMIT $2
           )
           SELECT count(*) FILTER (WHERE status = 'ok') AS usage_count,
             count(*) = $2 AS usage_truncated,
             min(ts) FILTER (WHERE status = 'ok') AS usage_since,
             max(ts) FILTER (WHERE status = 'ok') AS last_used_at,
             ARRAY(SELECT principal_id FROM (
               SELECT DISTINCT ON (principal_id) principal_id, ts, id FROM recent WHERE status = 'ok'
               ORDER BY principal_id, ts DESC, id DESC
             ) AS latest ORDER BY ts DESC, id DESC LIMIT 12) AS principals
           FROM recent
         ) AS summary`,
        [[...new Set(slugs)], CREDENTIAL_USAGE_WINDOW],
      );
      return rows.map((row) => ({
        slug: String(row.slug),
        usageCount: Number(row.usage_count),
        usageTruncated: Boolean(row.usage_truncated),
        usageSince: row.usage_since == null ? null : Number(row.usage_since),
        lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
        recentUsagePrincipals: row.principals as string[],
      }));
    },
  };
}
