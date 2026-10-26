import type { ErrorLog } from "../admin/error-log.ts";
import { turnFailureItem } from "../core/turn-error.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { EnqueueInput, EnqueueResult, RunStore } from "../runs/run-store.ts";
import { isUnstarted, runLeaseHeld, runPriority } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { ScopeId } from "../types.ts";
import type { TurnLedger } from "./turn-ledger.ts";

const TURN_REPAIRED_REASON = "This turn stopped unexpectedly and could not be resumed.";

export function routeTurns(
  base: RunStore,
  ledger: TurnLedger | undefined,
  flags: Pick<FeatureFlagStore, "enabled">,
): Pick<RunStore, "cancelTurn" | "cancelTree" | "withdraw" | "leaseHeld"> & {
  admit(input: EnqueueInput): Promise<EnqueueResult | null>;
} {
  return {
    async admit(input) {
      if (!ledger) return null;
      const scope = conversationScope(input.request.conversation, input.request.actor.id);
      if (!(await flags.enabled("absurd_turns", scope))) return null;
      const delegating = input.request.delegatingRunId ? await base.get(input.request.delegatingRunId) : null;
      return ledger.admit({ ...input, priority: runPriority(input.request, delegating?.priority ?? null) });
    },
    cancelTurn: async (runId) => ledger?.cancel(runId) ?? null,
    cancelTree: async (threadRefs) => ledger?.cancelTree(threadRefs) ?? 0,
    async withdraw(runId, opts) {
      const run = ledger ? await base.get(runId) : null;
      if (!ledger || run?.engine !== "absurd") return base.withdraw(runId, opts);
      if (!isUnstarted(run)) return false;
      return (await ledger.cancel(runId)) !== null;
    },
    leaseHeld: async (run, token) =>
      run.engine === "absurd" && ledger ? ledger.fenceHeld(run.id, token) : runLeaseHeld(base, run, token),
  };
}

export async function repairStaleTurns(deps: {
  ledger: TurnLedger;
  sessions: Pick<SessionStore, "getByThread" | "forceReleaseLease" | "acquireLease" | "append" | "releaseLease">;
  errors?: ErrorLog;
}): Promise<void> {
  await deps.ledger.releaseCapped();
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
