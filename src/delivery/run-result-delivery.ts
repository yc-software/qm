import { isSubagentThreadRef } from "../sessions/session-syscalls.ts";
import type { DeliveryProvenance, Destination, OutgoingAttachment } from "../types.ts";
import { waitForNoRunningRun, type Run, type RunStore } from "../runs/run-store.ts";
import { turnDeliveryProvenance, type DeliveryStore } from "./delivery-store.ts";
import { boundWebhook, isSessionTurn } from "../core/turn-origin.ts";
import { turnFailureItem } from "../core/turn-error.ts";
import { standaloneFailureText, unfinishedTurnText, userFacingFailureClause } from "../core/failure-copy.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { turnRecordedFailure } from "./web-transcript-delivery.ts";
import { reportFailureAs } from "../util/errors.ts";

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

export function replyEditNote(retracted: readonly string[] | undefined): string | undefined {
  return retracted?.length ? `Edited after a reply check: ${[...new Set(retracted)].join(", ")}` : undefined;
}

export type RunNotice = (run: Run) => string | undefined;

export function runResultDelivery(run: Run, adminUrlFor?: AdminUrlFor, notice?: RunNotice): RunResultDelivery | null {
  if (isSubagentThreadRef(run.sessionId) || run.request.swarm || run.request.privateSessionMessage) return null;
  const origin = run.request.origin;
  const surfaceOrigin = run.request.surfaceOrigin;
  const bound = boundWebhook(run.request);
  const webhook = bound?.webhook;
  const target = bound?.target ?? run.request.deliveryTarget;
  const surface = run.request.surface;
  if (!target || !surface) return null;
  const editRef = run.deliveryState?.editRef;
  const failed = run.status === "failed";
  const webTranscript = webTranscriptNote(run, surface, failed);
  const destination: Destination = {
    type: webhook ? "webhook" : surface,
    ...(webhook ? { webhook } : {}),
    target,
    ...(surfaceOrigin
      ? {
          account: {
            id: surfaceOrigin.author.account,
            workspace: surfaceOrigin.workspace,
            ...(surfaceOrigin.policyNamespace ? { policyNamespace: surfaceOrigin.policyNamespace } : {}),
          },
        }
      : {}),
    ...(editRef ? { editRef } : {}),
    ...(webTranscript ? { webTranscript } : {}),
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
  const noticeText = notice?.(run);
  if (noticeText) return { destination, text: noticeText, provenance, idempotencyKey };
  if (
    webhook &&
    run.request.idempotencyKey &&
    (run.request.approval || (origin.kind === "human" && !isSessionTurn(run.request)))
  )
    provenance.sourceRequestId = run.request.idempotencyKey;
  if (webhook) provenance.sourceRunId = run.id;
  if (
    surface === "slack" &&
    run.result?.status === "refused" &&
    (run.result.refusalKind === "security_quarantine" || run.result.refusalKind === "model_budget") &&
    run.request.addressed
  ) {
    return { destination, text: standaloneFailureText(run.result)!, provenance, idempotencyKey };
  }
  if (run.request.surfaceTools && run.result?.status !== "failed" && !run.result?.attachments?.length) return null;
  if (failed) {
    if (origin.kind === "ambient" && !isSessionTurn(run.request)) return null;
    const clause = userFacingFailureClause(run.result ?? { status: "failed" });
    const adminUrl = run.result?.sessionId ? adminUrlFor?.(run.result.sessionId) : undefined;
    const detail = adminUrl ? ` — full error: ${adminUrl}` : "";
    return { destination, text: unfinishedTurnText(`${clause}${detail}`), provenance, idempotencyKey };
  }
  if (run.result?.status === "ok" && (run.result.reply || run.result.attachments?.length)) {
    const editNote = replyEditNote(run.result.retracted);
    const persona = run.result.persona;
    return {
      destination: { ...destination, ...(editNote ? { editNote } : {}), ...(persona ? { persona } : {}) },
      text: run.result.reply ?? "",
      ...(run.result.attachments?.length ? { attachments: run.result.attachments } : {}),
      provenance,
      idempotencyKey,
    };
  }
  const nothingToShow = !provenance.sourceRequestId && (run.result?.status === "ok" || run.result?.status === "silent");
  if (webhook && run.result && !nothingToShow)
    return { destination, text: standaloneFailureText(run.result) ?? "", provenance, idempotencyKey };
  return null;
}

export type TurnFailureSessions = Pick<SessionStore, "append" | "getByThread" | "getItems">;

const FAILURE_RECORD_SCAN_LIMIT = 200;
const FAILURE_RECORD_WAIT_MS = 10 * 60_000;

export async function recordRunFailureEntry(
  sessions: TurnFailureSessions,
  runs: Pick<RunStore, "inFlightForThread">,
  run: Run,
): Promise<boolean> {
  if (run.status !== "failed" || run.request.swarm) return false;
  const session = await sessions.getByThread(run.sessionId);
  if (!session) {
    console.error(
      `[delivery] failed run ${run.id} targets ${run.sessionId}, which has no session — no turn_failure entry recorded`,
    );
    return false;
  }
  if (!(await waitForNoRunningRun(runs, run.sessionId, FAILURE_RECORD_WAIT_MS))) {
    console.error(`[delivery] session ${session.id} stayed busy — failed run ${run.id} has no turn_failure entry`);
    return false;
  }
  const tail = await sessions.getItems(session.id, { limit: FAILURE_RECORD_SCAN_LIMIT });
  if (turnRecordedFailure(tail, { notBefore: run.startedAt ?? run.createdAt, runId: run.id })) return false;
  const message = `I couldn't finish that turn: ${userFacingFailureClause(run.result ?? { status: "failed" })}`;
  await sessions.append({ sessionId: session.id }, turnFailureItem(message, run.id));
  return true;
}

const RUN_RESULT_SWEEP_LOOKBACK_MS = 60 * 60_000;
const RUN_RESULT_SWEEP_GRACE_MS = 60_000;
const RUN_RESULT_SWEEP_PAGE = 200;

export interface RunResultRecovery {
  sweep(now?: number): Promise<number>;
}

export function wireRunResultDeliveries(
  runs: Pick<RunStore, "onTerminal" | "terminalFinished" | "inFlightForThread">,
  deliveries: Pick<DeliveryStore, "enqueue" | "existingKeys">,
  adminUrlFor?: AdminUrlFor,
  sessions?: TurnFailureSessions,
  notice?: RunNotice,
): RunResultRecovery {
  const recover = async (run: Run): Promise<boolean> => {
    if (sessions) {
      void recordRunFailureEntry(sessions, runs, run).catch(
        reportFailureAs("delivery: record turn_failure entry", undefined, `run=${run.id}`),
      );
    }
    const delivery = runResultDelivery(run, adminUrlFor, notice);
    if (!delivery) return false;
    await deliveries.enqueue(delivery);
    return true;
  };
  runs.onTerminal((run) => {
    void recover(run).catch(reportFailureAs("delivery: enqueue recovery delivery", undefined, `run=${run.id}`));
  });
  return {
    async sweep(now = Date.now()) {
      const before = now - RUN_RESULT_SWEEP_GRACE_MS;
      let cursor = { finishedAt: now - RUN_RESULT_SWEEP_LOOKBACK_MS, id: "" };
      let recovered = 0;
      for (;;) {
        const batch = await runs.terminalFinished(cursor, before, RUN_RESULT_SWEEP_PAGE);
        const existing = await deliveries.existingKeys(batch.map((run) => `run:${run.id}`));
        for (const run of batch) {
          if (existing.has(`run:${run.id}`) || !(await recover(run))) continue;
          console.error(`[delivery] terminal run ${run.id} had no outbox row — enqueued its recovery delivery`);
          recovered += 1;
        }
        const last = batch.at(-1);
        if (!last || batch.length < RUN_RESULT_SWEEP_PAGE) return recovered;
        cursor = { finishedAt: last.finishedAt!, id: last.id };
      }
    },
  };
}
