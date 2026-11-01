import type { ErrorLog } from "../admin/error-log.ts";
import type { RunRows } from "../runs/postgres-run-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import { runPriority } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { ScopeId } from "../types.ts";
import type { TurnLedger } from "./turn-ledger.ts";

const TURN_REPAIRED_REASON = "This turn stopped unexpectedly and could not be resumed.";

export function bindTurnLedger(
  rows: Pick<RunRows, "get">,
  ledger: TurnLedger,
  maxAttempts: number,
): Pick<RunStore, "enqueue" | "withdraw" | "leaseHeld"> {
  return {
    async enqueue(input) {
      const delegating = input.request.delegatingRunId ? await rows.get(input.request.delegatingRunId) : null;
      return ledger.admit({
        ...input,
        maxAttempts: input.maxAttempts ?? maxAttempts,
        priority: runPriority(input.request, delegating?.priority ?? null),
      });
    },
    withdraw: (runId, opts) => ledger.withdraw(runId, opts),
    leaseHeld: (run, token) => ledger.fenceHeld(run.id, token),
  };
}

export async function sweepTurns(deps: {
  ledger: TurnLedger;
  sessions: Pick<SessionStore, "getByThread" | "forceReleaseLease">;
  errors?: ErrorLog;
}): Promise<void> {
  for (const threadRef of await deps.ledger.startStranded())
    deps.errors?.record({
      category: "runs",
      code: "turn_line_restarted",
      message: `conversation ${threadRef} had queued turns and no active turn; started the next one`,
      scopeLabel: "turns:pointer-repair" as ScopeId,
    });
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
    if (session) await deps.sessions.forceReleaseLease(session.id);
    await deps.ledger.release(candidate);
  }
}
