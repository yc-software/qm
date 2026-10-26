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
  tail(opts: {
    limit: number;
    scopeLabel?: ScopeId;
    action?: string | readonly string[];
    since?: number;
    resourceContains?: string;
  }): Promise<readonly AuditEvent[]>;
}

export const SECURITY_FLAGGED = "security_posture.flagged";
export const SECURITY_TOOL_RESULT_QUARANTINE = "security_posture.tool_result_quarantine";

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
    tail: async ({ limit, scopeLabel, action, since, resourceContains }) =>
      sink
        .list({ limit: MAX, ...(scopeLabel ? { scopeId: scopeLabel } : {}) })
        .filter(
          (e) =>
            (action === undefined || [action].flat().includes(e.action)) &&
            (since === undefined || e.at >= since) &&
            (resourceContains === undefined || e.resource.includes(resourceContains)),
        )
        .slice(0, limit),
  };
}
