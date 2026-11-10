import { reportBackendError } from "../../plugins/chassis/src/error-reporting.ts";
import { errorAlreadyReported, markErrorReported } from "../util/errors.ts";
import type { ScopeId } from "../types.ts";
import type { Tenant } from "../tenants/context.ts";

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

export function withErrorReporting(store: ErrorLog): ErrorLog {
  return {
    ...store,
    record(tenant, event, error) {
      if (!errorAlreadyReported(error)) {
        reportBackendError(error ?? new Error(event.message), `${event.category}:${event.code}`, { ...event });
        markErrorReported(error);
      }
      store.record(tenant, event);
    },
  };
}
