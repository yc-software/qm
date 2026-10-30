import type { ScopeId } from "../types.ts";
import { perTenant } from "../tenants/context.ts";

interface ModelCallRecord {
  at: number;
  scopeLabel: ScopeId;
  model: string;
  inputTokens: number;
  entryCount: number;
}

export interface ModelGateway {
  recordCall(rec: ModelCallRecord): void;
  audit(): readonly ModelCallRecord[];
}

const DEFAULT_MAX_RECORDS = 1_000;

export function createModelGateway(opts: { maxRecords?: number } = {}): ModelGateway {
  const max = Math.max(1, opts.maxRecords ?? DEFAULT_MAX_RECORDS);
  const records = perTenant((): ModelCallRecord[] => []);
  return {
    recordCall: (rec) => {
      const list = records();
      list.push(rec);
      if (list.length > max) list.splice(0, list.length - max);
    },
    audit: () => [...records()],
  };
}
