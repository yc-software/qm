import type { RunsModule } from "./runs.ts";
import { hasRows } from "../jobs/job-worker.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { StoresModule } from "./stores.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { OutboundModule } from "./outbound.ts";
import type { HarnessModule } from "./harness.ts";
import type { CredentialsModule } from "./credentials.ts";
import { swallowAs } from "../util/errors.ts";
import { type Session, scopeId } from "../types.ts";
import { sessionTreeWorking, stoppableAncestors } from "../subagents/tree.ts";
import type { Run } from "../runs/run-store.ts";
import { deliverSubagentMail } from "../subagents/mail.ts";
import { isSubagentThreadRef } from "../sessions/thread-ref.ts";
import { createSurfaceContextPuller } from "../api/surface-context-puller.ts";

type SessionReturnsInputs = {
  runs: RunsModule;
  apiApp: ApiAppModule;
  stores: StoresModule;
  orchestrator: OrchestratorModule;
  outbound: OutboundModule;
  harness: HarnessModule;
  credentials: CredentialsModule;
};

export function buildSessionReturns(deps: SessionReturnsInputs) {
  const { runs, sessionStateBus, blockingApprovalSessions, maxAttempts } = deps.runs;
  const { app } = deps.apiApp;
  const { sessions, advisoryLock, featureFlags, every } = deps.stores;
  const { sessionMailbox, prepareSessionRequest, orchestratorDeps } = deps.orchestrator;
  const { outbound } = deps.outbound;
  const { runSignals } = deps.harness;
  const { keychain } = deps.credentials;

  runs.onTerminal((run) => {
    void app.replayOrphanedRunSignals(run.id).catch(swallowAs("wake: orphaned-signal replay", undefined));
  });
  runs.onTerminal((run) => {
    void (async () => {
      const session = await sessions.getByThread(run.sessionId);
      const at = run.finishedAt ?? Date.now();
      if (!session) {
        if (!(await runs.activeForThread(run.sessionId)))
          sessionStateBus.emit({ threadRef: run.sessionId, state: "idle", at });
        return;
      }
      const settle = async (target: Session): Promise<boolean> => {
        if (await runs.activeForThread(target.threadRef)) return false;
        const waiting = (await blockingApprovalSessions([target.id])).has(target.id);
        if (!waiting && (await sessionTreeWorking(sessions, runs, target))) return false;
        const participants = await sessions.participantsOf(target.id);
        sessionStateBus.emit({
          threadRef: target.threadRef,
          sessionId: target.id,
          state: waiting ? "awaiting_approval" : "idle",
          at,
          ...(participants.length ? { participants } : {}),
        });
        return true;
      };
      if (!(await settle(session))) return;
      for (const ancestor of await stoppableAncestors(sessions, session)) if (!(await settle(ancestor))) return;
    })().catch(swallowAs("session-state: terminal emit", undefined));
  });
  const returnSessionRun = (run: Run) =>
    advisoryLock
      .withLock("session-tree-admission", async () => {
        const settled = await deliverSubagentMail(
          {
            sessions,
            runs,
            maxAttempts,
            mailbox: sessionMailbox,
            prepareRequest: prepareSessionRequest,
            delegationEnabled: (actorId) => featureFlags.enabled("responsive_spine", scopeId("personal", actorId)),
            outbound,
            signals: runSignals,
          },
          run,
        );
        if (settled) await runs.markReturned(run.id);
      })
      .catch(async (error: unknown) => {
        await runs.deferReturn(run.id, 60_000);
        throw error;
      });
  runs.onTerminal((run) => {
    if (isSubagentThreadRef(run.sessionId)) void returnSessionRun(run).catch(swallowAs("sessions: return", undefined));
  });
  const sweepSessionReturns = async () => {
    let afterId: string | undefined;
    for (;;) {
      const batch = await runs.pendingReturns(100, afterId);
      if (!batch.length) return;
      for (const run of batch) await returnSessionRun(run).catch(swallowAs("sessions: recover return", undefined));
      afterId = batch.at(-1)!.id;
    }
  };
  orchestratorDeps.surfaceContext = createSurfaceContextPuller(app, {
    searchToken: async (source, viewer) =>
      source === "slack" && viewer
        ? ((await keychain.connectorAccessToken("slack.com", viewer, "personal")) ??
          (await keychain.connectorAccessToken("slack.com", viewer)) ??
          keychain.connectorAccessToken("slack.com", viewer, "company"))
        : null,
  });
  every("session-return-sweep", 1_000, sweepSessionReturns, {
    due: `${hasRows(
      "runs",
      "w.status IN ('done','failed') AND w.returned_at IS NULL AND w.session_id LIKE 'agent:main:subagent:%'",
    )} OR ${hasRows(
      "runs",
      "w.status IN ('pending','queued') AND w.attempts = 0 AND w.idempotency_key LIKE 'subagent-return:%'",
    )}`,
  });
}
