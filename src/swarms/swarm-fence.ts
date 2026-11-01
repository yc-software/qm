import type { Run } from "../runs/run-store.ts";

export interface SwarmRunFence {
  runId: string;
  attempt: number;
  leaseToken: string;
  sessionId: string;
  threadRef: string;
  actorId: string;
  scopeId: string;
}

export function assertSwarmRun(
  fence: SwarmRunFence,
  run: Pick<Run, "status" | "attempts" | "leaseToken" | "sessionId" | "request"> | null,
  claimHeld: boolean,
): void {
  if (
    !run ||
    run.status !== "running" ||
    run.attempts !== fence.attempt ||
    !fence.leaseToken ||
    run.leaseToken !== fence.leaseToken ||
    !claimHeld ||
    run.sessionId !== fence.threadRef ||
    run.request.actor.id !== fence.actorId
  )
    throw new Error("active capability run required");
}
