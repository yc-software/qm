export interface LedgerBegin {
  cached: boolean;
  output?: string;
}

export interface ToolLedger {
  begin(runId: string, attempt: number, callIndex: number): Promise<LedgerBegin>;
  record(runId: string, attempt: number, callIndex: number, output: string): Promise<void>;
}

export function createNullLedger(): ToolLedger {
  return {
    async begin() {
      return { cached: false };
    },
    async record() {},
  };
}
