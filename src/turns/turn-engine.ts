import type { ErrorLog } from "../admin/error-log.ts";
import { turnFailureItem } from "../core/turn-error.ts";
import type { RunRows } from "../runs/postgres-run-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import { runPriority } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { ScopeId } from "../types.ts";
import type { TurnLedger } from "./turn-ledger.ts";

const TURN_REPAIRED_REASON = "This turn stopped unexpectedly and could not be resumed.";

/** Admission, cancellation and fencing of turns, all through the Absurd turn ledger. */
export function bindTurnLedger(
  rows: Pick<RunRows, "get">,
  ledger: TurnLedger,
): Pick<RunStore, "enqueue" | "cancelTurn" | "cancelTree" | "withdraw" | "leaseHeld"> {
  return {
    async enqueue(input) {
      const delegating = input.request.delegatingRunId ? await rows.get(input.request.delegatingRunId) : null;
      return ledger.admit({ ...input, priority: runPriority(input.request, delegating?.priority ?? null) });
    },
    cancelTurn: (runId) => ledger.cancel(runId),
    cancelTree: (threadRefs) => ledger.cancelTree(threadRefs),
    withdraw: (runId, opts) => ledger.withdraw(runId, opts),
    leaseHeld: (run, token) => ledger.fenceHeld(run.id, token),
  };
}

export async function sweepTurns(deps: {
  ledger: TurnLedger;
  sessions: Pick<SessionStore, "getByThread" | "forceReleaseLease" | "acquireLease" | "append" | "releaseLease">;
  errors?: ErrorLog;
}): Promise<void> {
  for (const candidate of await deps.ledger.repairCandidates()) {
    const repaired = await deps.ledger.repair(candidate, {
      status: "failed",
      sessionId: candidate.threadRef,
      reason: TURN_REPAIRED_REASON,
    });
    deps.errors?.record({
      category: "runs",
      code: "turn_pointer_repaired",
      message: `turn ${candidate.turnId}: ${candidate.reason}`,
      scopeLabel: "turns:pointer-repair" as ScopeId,
    });
    const session = repaired ? await deps.sessions.getByThread(candidate.threadRef) : null;
    if (session) {
      await deps.sessions.forceReleaseLease(session.id);
      const { lease } = await deps.sessions.acquireLease(session.id, "turn");
      if (lease)
        await deps.sessions
          .append(lease, turnFailureItem(TURN_REPAIRED_REASON, candidate.turnId))
          .finally(() => deps.sessions.releaseLease(lease));
    }
    await deps.ledger.release(candidate);
  }
}
