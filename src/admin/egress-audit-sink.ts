import type { ScopeId } from "../types.ts";
import type { Tenant } from "../tenants/context.ts";
import { createTimestampedEventSink } from "./scoped-event-sink.ts";

export interface EgressAuditRecord {
  ts: number;
  source: string;
  host: string;
  allowed: boolean;
  scopeLabel: ScopeId;
  port?: number;
  verdict?: string;
  via?: string;
  peerIp?: string;
  principalId?: string;
  tenant?: string;
}

interface EgressAuditQuery {
  scopeId?: string;
  source?: string;
  since?: number;
  limit?: number;
}

export interface EgressAuditSink {
  record(t: Tenant, r: Omit<EgressAuditRecord, "ts">): void;
  list(t: Tenant, opts?: EgressAuditQuery): Promise<EgressAuditRecord[]>;
}

export interface EgressAuditRecorder {
  record(r: Omit<EgressAuditRecord, "ts">): void;
}

export function createEgressAuditSink(): EgressAuditRecorder & {
  list(opts?: EgressAuditQuery): Promise<EgressAuditRecord[]>;
} {
  return createTimestampedEventSink<EgressAuditRecord>({ max: 10000, defaultLimit: 5000, equalityFields: ["source"] });
}
