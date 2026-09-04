import type { ScopeId } from "../types.ts";
import { createScopedEventSink } from "../admin/scoped-event-sink.ts";

export interface AuditEvent {
  at: number;
  principalId: string;
  action: string;
  resource: string;
  scopeLabel: ScopeId;
  status?: string;
  detail?: string;
}

export interface AuditLog {
  record(e: AuditEvent): void;
  recordOnce?(key: string, e: AuditEvent): Promise<void>;
  events(): Promise<readonly AuditEvent[]>;
  tail(opts: { limit: number; scopeLabel?: ScopeId; action?: string; since?: number }): Promise<readonly AuditEvent[]>;
}

const MAX = 50000;

export function createAuditLog(): AuditLog {
  const sink = createScopedEventSink<AuditEvent, AuditEvent>({
    max: MAX,
    defaultLimit: MAX,
    stamp: (e) => e,
  });
  const once = new Set<string>();
  return {
    record: (e) => sink.record(e),
    async recordOnce(key, e) {
      if (once.has(key)) return;
      sink.record(e);
      once.add(key);
    },
    events: async () => sink.all(),
    tail: async ({ limit, scopeLabel, action, since }) =>
      sink
        .list({ limit: MAX, ...(scopeLabel ? { scopeId: scopeLabel } : {}) })
        .filter((e) => (action === undefined || e.action === action) && (since === undefined || e.at >= since))
        .slice(0, limit),
  };
}
