import { createPostgresEventSink, type EventColumn } from "./scoped-event-sink.ts";
import type { EgressAuditRecord, EgressAuditSink } from "./egress-audit-sink.ts";

const COLUMNS: readonly EventColumn<keyof EgressAuditRecord & string>[] = [
  ["ts", "ts", "BIGINT", "number", true],
  ["source", "source", "TEXT", "string", true],
  ["host", "host", "TEXT", "string", true],
  ["allowed", "allowed", "BOOLEAN", "boolean", true],
  ["scope_label", "scopeLabel", "TEXT", "string", true],
  ["port", "port", "INT", "number"],
  ["verdict", "verdict", "TEXT", "string"],
  ["via", "via", "TEXT", "string"],
  ["peer_ip", "peerIp", "TEXT", "string"],
  ["principal_id", "principalId", "TEXT", "string"],
];

export function createPostgresEgressAuditSink(connectionString: string): EgressAuditSink {
  return createPostgresEventSink<EgressAuditRecord>({
    connectionString,
    table: "egress_events",
    columns: COLUMNS,
    defaultLimit: 5000,
    equalityFilters: { scopeId: "scope_label", source: "source" },
    persistErrorMessage: "[egress-audit] failed to persist egress decision:",
  });
}
