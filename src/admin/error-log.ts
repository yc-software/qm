import { reportBackendError } from "../../plugins/chassis/src/error-reporting.ts";
import { errorAlreadyReported, markErrorReported } from "../util/errors.ts";
import { isProviderDecision } from "../core/turn-error.ts";
import type { ScopeId } from "../types.ts";
import { ambientTenant, boundTenant, type Tenant } from "../tenants/context.ts";

export interface ErrorEvent {
  ts: number;
  category: string;
  code: string;
  message: string;
  scopeLabel: ScopeId;
  sessionId?: string;
}

export interface ErrorLog {
  record(t: Tenant, e: Omit<ErrorEvent, "ts">, error?: unknown): void;
  flush(): Promise<void>;
  list(
    t: Tenant,
    opts?: { scopeId?: string; sessionId?: string; limit?: number; offset?: number },
  ): Promise<ErrorEvent[]>;
  count(t: Tenant, opts?: { scopeId?: string; sessionId?: string }): Promise<number>;
}

function reportErrorEvent(event: Omit<ErrorEvent, "ts">, error?: unknown): void {
  if (errorAlreadyReported(error)) return;
  if (!isProviderDecision(error))
    reportBackendError(error ?? new Error(event.message), `${event.category}:${event.code}`, { ...event });
  markErrorReported(error);
}

export function recordErrorInBinding(
  errors: Pick<ErrorLog, "record"> | undefined,
  event: Omit<ErrorEvent, "ts">,
  error?: unknown,
): void {
  if (!errors) return;
  if (boundTenant() === undefined) reportErrorEvent(event, error);
  else errors.record(ambientTenant(), event, error);
}

export function withErrorReporting(store: ErrorLog): ErrorLog {
  return {
    ...store,
    record(tenant, event, error) {
      reportErrorEvent(event, error);
      store.record(tenant, event);
    },
  };
}
