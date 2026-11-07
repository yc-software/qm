export interface EvalCommandEvidence {
  id: string;
  program?: string;
  args?: string[];
  requiresDatabase?: boolean;
  passed?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
}

export interface EvalCaseEvidence {
  id: string;
  passed: boolean;
  invariant: string;
  selectors: Array<{ file: string; name: string }>;
  failedCommandIds: string[];
  missingSelectors?: Array<{ commandId: string; file: string; name: string }>;
  durationMs: number;
}

export interface EvalSummaryEvidence {
  sourceRevision?: string;
  sourceStateDigest?: string;
  sourceDirty?: boolean;
  databaseConfigured?: boolean;
  liveServices?: boolean;
  durationMs: number;
  commands: EvalCommandEvidence[];
  cases: EvalCaseEvidence[];
}

export function renderJunit(summary: EvalSummaryEvidence): string;
export function defaultOutputDirectory(now: number, pid: number): string;
