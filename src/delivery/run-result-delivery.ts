import type { DeliveryProvenance, Destination, OutgoingAttachment } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import { turnDeliveryProvenance, type DeliveryStore } from "./delivery-store.ts";
import type { Task, TaskStore } from "../tasks/task-store.ts";
import { isPersonAuthored, resolveTurnOrigin } from "../core/turn-origin.ts";
import type { TurnFailurePayload } from "../core/turn-error.ts";
import { standaloneFailureText, userFacingFailureClause } from "../core/failure-copy.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import {
  acquireLeaseWithin,
  appendEntryOutsideTurn,
  entryDeliveryKey,
  type SessionStore,
  type TranscriptAppendSessions,
} from "../sessions/session-store.ts";
import { turnRecordedFailure } from "./web-transcript-delivery.ts";

export interface RunResultDelivery {
  destination: Destination;
  text: string;
  attachments?: OutgoingAttachment[];
  provenance: DeliveryProvenance;
  idempotencyKey: string;
}

function webTranscriptNote(run: Run, surface: string, failed: boolean): Destination["webTranscript"] | undefined {
  if (surface !== "web") return undefined;
  if (failed) return { kind: "turn_failure", notBefore: run.startedAt ?? run.createdAt, runId: run.id };
  const recoveredReply =
    run.result?.status === "ok" && Boolean(run.result.reply) && run.result.sourceAssistantEntrySeq === undefined;
  return recoveredReply ? { kind: "reply" } : undefined;
}

export type AdminUrlFor = (sessionId: string) => string | undefined;

export function runResultDelivery(
  run: Run,
  taskList: Task[] = [],
  adminUrlFor?: AdminUrlFor,
): RunResultDelivery | null {
  if (run.request.swarm || run.request.privateSessionMessage) return null;
  const target = run.request.deliveryTarget;
  const surface = run.request.surface;
  if (!target || !surface) return null;
  const origin = resolveTurnOrigin(run.request);
  const approvalCard = run.request.slackDeliveryContext?.approvalCard;
  const editRef =
    run.deliveryState?.editRef ??
    (approvalCard && approvalCard.channel === target.split(":")[0] ? approvalCard.messageTs : undefined);
  const failed = run.status === "failed";
  const webTranscript = webTranscriptNote(run, surface, failed);
  const destination: Destination = {
    type: surface,
    target,
    ...(run.request.slackDeliveryContext?.account ? { slackAccount: run.request.slackDeliveryContext.account } : {}),
    ...(editRef ? { editRef } : {}),
    ...(taskList.length ? { taskList: taskList.map(({ id, title, status }) => ({ id, title, status })) } : {}),
    ...(webTranscript ? { webTranscript } : {}),
    ...(run.result?.pendingApprovals?.length
      ? { approvalRequestIds: run.result.pendingApprovals.map((approval) => approval.requestId) }
      : {}),
  };
  const idempotencyKey = `run:${run.id}`;
  const provenance = turnDeliveryProvenance({
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
    run.result.refusalKind === "security_quarantine" &&
    run.request.addressed
  ) {
    return { destination, text: standaloneFailureText(run.result)!, provenance, idempotencyKey };
  }
  if (run.result?.status === "pending_approval" && run.result.pendingApprovals?.length) {
    if (
      run.request.surfaceTools &&
      !run.request.addressed &&
      !isPersonAuthored(origin.kind) &&
      run.result.pendingApprovals.every((approval) => approval.kind === "input")
    )
      return null;
    return { destination, text: "", provenance, idempotencyKey };
  }
  if (
    run.request.surfaceTools &&
    run.result?.status !== "failed" &&
    !run.result?.attachments?.length &&
    !run.result?.pendingApprovals?.length
  )
    return null;
  if (failed) {
    if (origin.kind === "ambient") return null;
    const clause = userFacingFailureClause(run.result ?? { status: "failed" });
    const adminUrl = run.result?.sessionId ? adminUrlFor?.(run.result.sessionId) : undefined;
    const detail = adminUrl ? ` — full error: ${adminUrl}` : "";
    return { destination, text: `⚠️ I couldn't finish that turn: ${clause}${detail}`, provenance, idempotencyKey };
  }
  if (run.result?.status === "ok" && (run.result.reply || run.result.attachments?.length)) {
    return {
      destination,
      text: run.result.reply ?? "",
      ...(run.result.attachments?.length ? { attachments: run.result.attachments } : {}),
      provenance,
      idempotencyKey,
    };
  }
  return null;
}

export type TurnFailureSessions = TranscriptAppendSessions &
  Pick<SessionStore, "getByThread" | "acquireLease" | "peekLease" | "releaseLease" | "getEntries">;

const FAILURE_RECORD_WAIT_MS = 10 * 60_000;

export async function recordRunFailureEntry(sessions: TurnFailureSessions, run: Run): Promise<boolean> {
  if (run.status !== "failed" || run.request.swarm) return false;
  const session = await sessions.getByThread(run.sessionId);
  if (!session) {
    console.error(
      `[delivery] failed run ${run.id} targets ${run.sessionId}, which has no session — no turn_failure entry recorded`,
    );
    return false;
  }
  const { lease } = await acquireLeaseWithin(sessions, session.id, "backfill", FAILURE_RECORD_WAIT_MS);
  if (!lease) {
    console.error(`[delivery] session ${session.id} stayed busy — failed run ${run.id} has no turn_failure entry`);
    return false;
  }
  try {
    const tail = await sessions.getEntries(session.id);
    if (turnRecordedFailure(tail, { notBefore: run.startedAt ?? run.createdAt, runId: run.id })) return false;
    if (tail.some((entry) => entryDeliveryKey(entry) === `run:${run.id}`)) return false;
    const payload: TurnFailurePayload = {
      kind: "turn_failure",
      message: `I couldn't finish that turn: ${userFacingFailureClause(run.result ?? { status: "failed" })}`,
      runId: run.id,
    };
    await appendEntryOutsideTurn(sessions, lease, { type: "system", payload, scopeLabel: session.scopeId });
    return true;
  } finally {
    await sessions.releaseLease(lease);
  }
}

export async function deliverRunResult(
  runs: RunStore,
  deliveries: DeliveryStore,
  runId: string,
  tasks?: TaskStore,
  adminUrlFor?: AdminUrlFor,
  sessions?: TurnFailureSessions,
): Promise<void> {
  const run = await runs.get(runId);
  if (!run || (run.status !== "done" && run.status !== "failed")) return;
  if (sessions) await recordRunFailureEntry(sessions, run);
  const taskList = tasks ? await tasks.list({ originRunId: run.id }) : [];
  const delivery = runResultDelivery(run, taskList, adminUrlFor);
  if (delivery) {
    await deliveries.enqueue(delivery);
  } else if (
    run.request.surface === "slack" &&
    run.request.deliveryTarget &&
    Boolean(run.request.slackDeliveryContext || run.deliveryState) &&
    !run.request.privateSessionMessage &&
    !run.request.swarm
  ) {
    await deliveries.enqueue({
      destination: {
        type: "slack",
        target: run.request.deliveryTarget,
        ...(run.request.slackDeliveryContext?.account
          ? { slackAccount: run.request.slackDeliveryContext.account }
          : {}),
        ...(!run.request.surfaceTools && run.deliveryState?.editRef ? { editRef: run.deliveryState.editRef } : {}),
      },
      text: "",
      idempotencyKey: `run:${run.id}`,
    });
  }
}
