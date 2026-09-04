export interface TurnOutcomeInput {
  reply?: string;
  attachments: number;
  issues: number;
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
  const completed = Boolean(i.reply?.trim()) || i.attachments > 0 || i.issues > 0;
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

export function sessionStateAfterTurn(o: TurnOutcome): "idle" | "awaiting_approval" {
  return o.awaitingApproval ? "awaiting_approval" : "idle";
}
