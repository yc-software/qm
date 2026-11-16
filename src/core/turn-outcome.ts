import type { StopScope, TurnResult } from "../types.ts";

export interface TurnOutcomeInput {
  reply?: string;
  attachments: number;
  pendingApprovals: ReadonlyArray<{ kind?: string }>;
  terminatedOnApproval: boolean;
}

export interface TurnOutcome {
  completed: boolean;
  paused: boolean;
  approvalsBlock: boolean;
  awaitingApproval: boolean;
}

export function deriveTurnOutcome(i: TurnOutcomeInput): TurnOutcome {
  const completed = Boolean(i.reply?.trim()) || i.attachments > 0;
  const paused = i.pendingApprovals.length > 0 && !completed;
  const approvalsBlock = paused || i.terminatedOnApproval;
  return {
    completed,
    paused,
    approvalsBlock,
    awaitingApproval:
      approvalsBlock && i.pendingApprovals.some((pa) => approvalBlocksInput(pa.kind, { approvalsBlock })),
  };
}

export function approvalBlocksInput(kind: string | undefined, outcome: Pick<TurnOutcome, "approvalsBlock">): boolean {
  return kind !== "input" && outcome.approvalsBlock;
}

export function heldReplyResult(o: {
  sessionId: string;
  stopped: boolean;
  stopScope?: StopScope;
  runCancelled: boolean;
  surfaceTools: boolean;
}): TurnResult | undefined {
  if (!o.runCancelled && !o.surfaceTools) return undefined;
  return {
    status: "silent",
    sessionId: o.sessionId,
    ...(o.stopped ? { stopped: true, ...(o.stopScope ? { stopScope: o.stopScope } : {}) } : {}),
  };
}
