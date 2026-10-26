import { legacyLeaseHeld, type Run } from "../runs/run-store.ts";

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
  run:
    | (Pick<Run, "status" | "attempts" | "leaseToken" | "leaseExpiresAt" | "sessionId" | "request" | "engine"> & {
        turnFenceHeld?: boolean;
      })
    | null,
): void {
  if (
    !run ||
    run.attempts !== fence.attempt ||
    !fence.leaseToken ||
    !(run.engine === "absurd" ? run.turnFenceHeld === true : legacyLeaseHeld(run, fence.leaseToken)) ||
    run.sessionId !== fence.threadRef ||
    run.request.actor.id !== fence.actorId
  )
    throw new Error("active capability run required");
}
