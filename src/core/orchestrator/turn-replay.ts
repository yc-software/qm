import type { TurnCtx } from "./turn-context.ts";
import type { Session } from "../../types.ts";
import { type TurnResult } from "../../types.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import type { HarnessDetectResult } from "../../harness/harness.ts";
import { createTranscriptSource } from "../../sessions/transcript-source.ts";
import { findTrailingPartialTurn, turnAtSeq } from "../turn-resume.ts";
import type { RecordedTurn } from "../turn-resume.ts";
import { errMessage } from "../../util/errors.ts";
import { absoluteAppLinks } from "../../util/markdown.ts";
import type { OrchestratorDeps } from "./types.ts";

const DETECT_HISTORY_TAIL = 400;

export async function findRecordedTurn(ctx: TurnCtx, session: Session): Promise<RecordedTurn | null> {
  const { deps, input } = ctx;
  if (!input.runId || !deps.runs) return null;
  const seq = (await deps.runs.get(input.runId))?.turnUserSeq;
  if (seq == null) return null;
  const entries = await deps.sessions.getItems(session.id, { sinceSeq: seq });
  if (entries[0]?.seq !== seq) return null;
  return turnAtSeq(entries, seq);
}

export function replayRecordedAnswer(
  ctx: TurnCtx,
  session: Session,
  recordedTurn: RecordedTurn,
): TurnResult | undefined {
  const { deps, input, actor, conversation, scopeId } = ctx;
  if (!recordedTurn.answer) return undefined;
  const recordedAnswer = recordedTurn.answer;
  deps.auditLog.record({
    at: Date.now(),
    principalId: actor.id,
    action: "turn.already_answered",
    resource: conversation.threadRef,
    scopeLabel: scopeId,
    detail: `attempt ${input.attempt}; replaying the answer the previous attempt recorded at seq ${recordedAnswer.seq}`,
  });
  console.error(
    `[orchestrator] turn.already_answered attempt=${input.attempt} run=${input.runId} thread=${conversation.threadRef} answerSeq=${recordedAnswer.seq}`,
  );
  return recordedAnswer.text.trim()
    ? {
        status: "ok",
        sessionId: session.id,
        reply: absoluteAppLinks(recordedAnswer.text, deps.publicWebUrl),
        sourceUserSeq: recordedTurn.userSeq,
        sourceAssistantEntrySeq: recordedAnswer.seq,
      }
    : { status: "silent", sessionId: session.id };
}

export async function detectAmbientDecline(
  ctx: TurnCtx,
  turn: {
    session: Session;
    recordedTurn: RecordedTurn | null;
    historyWindow: () => ReturnType<OrchestratorDeps["sessions"]["getContextWindow"]>;
    transcripts: ReturnType<typeof createTranscriptSource>;
  },
): Promise<TurnResult | undefined> {
  const { deps, input, actor, conversation, ambientTurn, sessionTurn, resolution, scopeId, filterHistory, isRetry } =
    ctx;
  const { session, recordedTurn, historyWindow, transcripts } = turn;
  if (
    ambientTurn &&
    !sessionTurn &&
    deps.harness.models.shouldRespond &&
    !(
      isRetry &&
      (recordedTurn ?? findTrailingPartialTurn((await transcripts.forRender(session.id)).items, input.runId))
    )
  ) {
    const detectHistory = filterHistory((await historyWindow()).items.slice(-DETECT_HISTORY_TAIL));
    const decision = await deps.harness.models
      .shouldRespond({
        session,
        message: input.text,
        recentContext: input.detectContext ?? "",
        ...(input.detectOpener ? { threadOpener: input.detectOpener } : {}),
        systemPrompt: resolution.systemPrompt,
        ...(input.gatewayContext?.reactionGuidance ? { reactionGuidance: input.gatewayContext.reactionGuidance } : {}),
        history: detectHistory,
        recordModelCall: (rec) => {
          deps.modelGateway.recordCall({ at: Date.now(), scopeLabel: scopeId, ...rec });
          void deps.budget?.record(actor.id, estimateCostUsd(rec.inputTokens));
        },
      })
      .catch((e: unknown): HarnessDetectResult => {
        deps.errors?.record(
          {
            category: "turn",
            code: "detection_failed",
            message: errMessage(e),
            scopeLabel: scopeId,
            sessionId: session.id,
          },
          e,
        );
        return { respond: false, reason: `detection failed: ${errMessage(e)}` };
      });
    if (!decision.respond) {
      const reactions = decision.reactions?.length ? decision.reactions : undefined;
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: reactions ? "turn.react" : "turn.silent",
        resource: conversation.threadRef,
        scopeLabel: scopeId,
        ...(decision.reason ? { detail: decision.reason } : {}),
      });
      console.error(
        `[orchestrator] turn.${reactions ? "react" : "silent"} (detection ${reactions ? `acknowledged emoji=${reactions.join(",")}` : "declined"}) thread=${conversation.threadRef}` +
          (decision.reason ? ` reason=${JSON.stringify(decision.reason)}` : ""),
      );
      return reactions
        ? { status: "react", sessionId: session.id, reactions }
        : { status: "silent", sessionId: session.id };
    }
  }
  return undefined;
}
