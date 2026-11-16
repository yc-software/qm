import type { ScopeId } from "../types.ts";
import { ambientTenant, boundTenant, type Tenant } from "../tenants/context.ts";
import { reportFailure } from "../util/errors.ts";

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
  record(t: Tenant, e: AuditEvent): void;
  recordOnce?(t: Tenant, key: string, e: AuditEvent): Promise<void>;
  events(t: Tenant): Promise<readonly AuditEvent[]>;
  tail(
    t: Tenant,
    opts: {
      limit: number;
      scopeLabel?: ScopeId;
      action?: string | readonly string[];
      since?: number;
      resourceContains?: string;
    },
  ): Promise<readonly AuditEvent[]>;
}

export const SECURITY_FLAGGED = "security_posture.flagged";
export const SECURITY_TOOL_RESULT_QUARANTINE = "security_posture.tool_result_quarantine";

export function recordAuditInBinding(auditLog: Pick<AuditLog, "record"> | undefined, e: AuditEvent): void {
  if (!auditLog) return;
  if (boundTenant() === undefined) reportFailure("audit: persist event", new Error("No tenant is bound to this work"));
  else auditLog.record(ambientTenant(), e);
}
