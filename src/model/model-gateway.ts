import type { ScopeId } from "../types.ts";

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
  const records: ModelCallRecord[] = [];
  return {
    recordCall: (rec) => {
      records.push(rec);
      if (records.length > max) records.splice(0, records.length - max);
    },
    audit: () => [...records],
  };
}
