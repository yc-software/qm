import type { CapabilityClaims } from "../auth/capability-token.ts";
import { samePerson } from "../directory/person.ts";
import type { Run, RunStore } from "./run-store.ts";

export async function activeCapabilityRun(
  runs: Pick<RunStore, "get" | "leaseHeld"> | undefined,
  cap: Pick<CapabilityClaims, "runId" | "runLeaseToken" | "runAttempt" | "threadRef" | "actorId">,
): Promise<Run | null> {
  const run = runs && cap.runId ? await runs.get(cap.runId) : null;
  if (
    !run ||
    run.status !== "running" ||
    !cap.runLeaseToken ||
    run.leaseToken !== cap.runLeaseToken ||
    run.attempts !== cap.runAttempt ||
    run.sessionId !== cap.threadRef ||
    !samePerson(run.request.actor.id, cap.actorId) ||
    !(await runs!.leaseHeld(run, cap.runLeaseToken))
  )
    return null;
  return run;
}
