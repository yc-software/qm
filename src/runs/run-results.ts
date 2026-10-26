import { isSubagentThreadRef } from "../sessions/session-syscalls.ts";
import type { Destination } from "../types.ts";
import type { Item } from "../sessions/items.ts";
import type { Run, RunStore } from "./run-store.ts";
import { turnPostProvenance, type Outbound, type OutboundPost } from "../surfaces/outbound.ts";
import { isSessionTurn, resolveTurnOrigin } from "../core/turn-origin.ts";
import { turnFailureItem } from "../core/turn-error.ts";
import { standaloneFailureText, userFacingFailureClause } from "../core/failure-copy.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { acquireLeaseWithin, type SessionStore } from "../sessions/session-store.ts";
import { reportFailureAs } from "../util/errors.ts";

function turnRecordedFailure(tail: readonly Item[], note: { notBefore: number; runId?: string }): boolean {
  return tail.some((item) => {
    if (item.kind !== "Error") return false;
    if (item.turnId !== null) return item.turnId === note.runId;
    return item.createdAt >= note.notBefore;
  });
}

export type AdminUrlFor = (sessionId: string) => string | undefined;

export function runResultPost(run: Run, adminUrlFor?: AdminUrlFor): OutboundPost | null {
  if (isSubagentThreadRef(run.sessionId) || run.request.swarm || run.request.privateSessionMessage) return null;
  const target = run.request.deliveryTarget;
  const surface = run.request.surface;
  if (!target || !surface) return null;
  const origin = resolveTurnOrigin(run.request);
  const editRef = run.deliveryState?.editRef;
  const failed = run.status === "failed";
  if (surface === "web") {
    const unrecordedReply =
      run.result?.status === "ok" && Boolean(run.result.reply) && run.result.sourceAssistantEntrySeq === undefined;
    if (!unrecordedReply) return null;
  }
  const webTranscript: Destination["webTranscript"] | undefined = surface === "web" ? { kind: "reply" } : undefined;
  const destination: Destination = {
    type: surface,
    target,
    ...(run.request.slackSource
      ? { slackAccountId: run.request.slackSource.accountId, slackTeamId: run.request.slackSource.teamId }
      : {}),
    ...(run.request.slackSource?.externalPolicyNamespace
      ? { slackPolicyNamespace: run.request.slackSource.externalPolicyNamespace }
      : {}),
    ...(editRef ? { editRef } : {}),
    ...(webTranscript ? { webTranscript } : {}),
  };
  const idempotencyKey = `run:${run.id}`;
  const createdAt = run.finishedAt ?? run.createdAt;
  const provenance = turnPostProvenance({
    origin,
    surface,
    fireKey: idempotencyKey,
    sourceScopeId: conversationScope(run.request.conversation, run.request.actor.id),
    sourceThreadRef: run.request.conversation.threadRef,
    ...(run.result?.sessionId ? { sourceSessionId: run.result.sessionId } : {}),
    ...(run.result?.sourceUserSeq !== undefined ? { sourceUserSeq: run.result.sourceUserSeq } : {}),
    ...(run.result?.sourceAssistantEntrySeq !== undefined
      ? { sourceAssistantEntrySeq: run.result.sourceAssistantEntrySeq }
      : {}),
  });
  if (
    surface === "slack" &&
    run.result?.status === "refused" &&
    (run.result.refusalKind === "security_quarantine" || run.result.refusalKind === "model_budget") &&
    run.request.addressed
  ) {
    return { destination, text: standaloneFailureText(run.result)!, provenance, idempotencyKey, createdAt };
  }
  if (run.request.surfaceTools && run.result?.status !== "failed" && !run.result?.attachments?.length) return null;
  if (failed) {
    if (origin.kind === "ambient" && !isSessionTurn(run.request)) return null;
    const clause = userFacingFailureClause(run.result ?? { status: "failed" });
    const adminUrl = run.result?.sessionId ? adminUrlFor?.(run.result.sessionId) : undefined;
    const detail = adminUrl ? ` — full error: ${adminUrl}` : "";
    return {
      destination,
      text: `⚠️ I couldn't finish that turn: ${clause}${detail}`,
      provenance,
      idempotencyKey,
      createdAt,
    };
  }
  if (run.result?.status === "ok" && (run.result.reply || run.result.attachments?.length)) {
    return {
      destination,
      text: run.result.reply ?? "",
      ...(run.result.attachments?.length ? { attachments: run.result.attachments } : {}),
      provenance,
      idempotencyKey,
      createdAt,
    };
  }
  return null;
}

export type TurnFailureSessions = Pick<
  SessionStore,
  "append" | "getByThread" | "acquireLease" | "peekLease" | "releaseLease" | "getItems"
>;

const FAILURE_RECORD_SCAN_LIMIT = 200;
const FAILURE_RECORD_WAIT_MS = 10 * 60_000;

export async function recordRunFailureEntry(sessions: TurnFailureSessions, run: Run): Promise<boolean> {
  if (run.status !== "failed" || run.request.swarm) return false;
  const session = await sessions.getByThread(run.sessionId);
  if (!session) {
    console.error(
      `[run-results] failed run ${run.id} targets ${run.sessionId}, which has no session — no turn_failure entry recorded`,
    );
    return false;
  }
  const { lease } = await acquireLeaseWithin(sessions, session.id, "backfill", FAILURE_RECORD_WAIT_MS);
  if (!lease) {
    console.error(`[run-results] session ${session.id} stayed busy — failed run ${run.id} has no turn_failure entry`);
    return false;
  }
  try {
    const tail = await sessions.getItems(session.id, { limit: FAILURE_RECORD_SCAN_LIMIT });
    if (turnRecordedFailure(tail, { notBefore: run.startedAt ?? run.createdAt, runId: run.id })) return false;
    await sessions.append(
      lease,
      turnFailureItem(
        `I couldn't finish that turn: ${userFacingFailureClause(run.result ?? { status: "failed" })}`,
        run.id,
      ),
    );
    return true;
  } finally {
    await sessions.releaseLease(lease);
  }
}

const RUN_RESULT_SWEEP_LOOKBACK_MS = 60 * 60_000;
const RUN_RESULT_SWEEP_GRACE_MS = 60_000;
const RUN_RESULT_SWEEP_PAGE = 200;
const RUN_RECOVERY_GRACE_MS = 15_000;

export interface RunResultRecovery {
  sweep(now?: number): Promise<number>;
}

export function wireRunResultPosts(
  runs: Pick<RunStore, "onTerminal" | "terminalFinished" | "get" | "setDeliveryState">,
  outbound: Pick<Outbound, "send">,
  opts: { adminUrlFor?: AdminUrlFor; sessions?: TurnFailureSessions; graceMs?: number } = {},
): RunResultRecovery {
  const graceMs = opts.graceMs ?? RUN_RECOVERY_GRACE_MS;
  const owed = (run: Run): OutboundPost | null =>
    run.deliveryState?.postedAt === undefined ? runResultPost(run, opts.adminUrlFor) : null;
  const postOwed = async (run: Run, post: OutboundPost): Promise<boolean> => {
    try {
      const receipt = await outbound.send(post);
      if (receipt?.deferred) return false;
    } catch (error) {
      if (!(error as { permanent?: boolean }).permanent) throw error;
      reportFailureAs("run results: reply is undeliverable (not retried)", undefined, `run=${run.id}`)(error);
      await runs.setDeliveryState(run.id, null, { postedAt: Date.now() });
      return false;
    }
    await runs.setDeliveryState(run.id, null, { postedAt: Date.now() });
    return true;
  };
  runs.onTerminal((run) => {
    if (opts.sessions)
      void recordRunFailureEntry(opts.sessions, run).catch(
        reportFailureAs("run results: record turn_failure entry", undefined, `run=${run.id}`),
      );
    if (!owed(run)) return;
    void (async () => {
      if (run.request.surface !== "web") await new Promise((resolve) => setTimeout(resolve, graceMs).unref?.());
      const latest = (await runs.get(run.id)) ?? run;
      const post = owed(latest);
      if (post) await postOwed(latest, post);
    })().catch(reportFailureAs("run results: post recovered result (the sweep retries)", undefined, `run=${run.id}`));
  });
  return {
    async sweep(now = Date.now()) {
      const before = now - RUN_RESULT_SWEEP_GRACE_MS;
      let cursor = { finishedAt: now - RUN_RESULT_SWEEP_LOOKBACK_MS, id: "" };
      let recovered = 0;
      for (;;) {
        const batch = await runs.terminalFinished(cursor, before, RUN_RESULT_SWEEP_PAGE);
        for (const run of batch) {
          const post = owed(run);
          if (!post) continue;
          try {
            if (!(await postOwed(run, post))) continue;
            console.error(`[run-results] terminal run ${run.id} still owed its reply — posted it`);
            recovered += 1;
          } catch (error) {
            reportFailureAs("run results: sweep post", undefined, `run=${run.id}`)(error);
          }
        }
        const last = batch.at(-1);
        if (!last || batch.length < RUN_RESULT_SWEEP_PAGE) return recovered;
        cursor = { finishedAt: last.finishedAt!, id: last.id };
      }
    },
  };
}
