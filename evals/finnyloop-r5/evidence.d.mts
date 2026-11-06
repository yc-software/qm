export interface EvalCommandEvidence {
  id: string;
  stdout?: string;
  stderr?: string;
}

export interface EvalCaseEvidence {
  id: string;
  passed: boolean;
  invariant: string;
  selectors: Array<{ file: string; name: string }>;
  failedCommandIds: string[];
  durationMs: number;
}

export interface EvalSummaryEvidence {
  durationMs: number;
  commands: EvalCommandEvidence[];
  cases: EvalCaseEvidence[];
}

export function renderJunit(summary: EvalSummaryEvidence): string;
export function defaultOutputDirectory(now: number, pid: number): string;
