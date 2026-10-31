import type { ScopeId } from "../types.ts";

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
