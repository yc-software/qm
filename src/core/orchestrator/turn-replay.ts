import type { OpenStoredFile } from "../attachments.ts";
import { restoreAttachmentState, attachmentSnapshot } from "./attach-tool.ts";
import { recordReplyFiles } from "./settle.ts";
import type { SessionWriter } from "../../sessions/session-store.ts";
import type { AuditEvent } from "../../audit/audit-log.ts";
import type { Item } from "../../sessions/items.ts";
import { replayRecordedSurfaceAnswer, surfaceToolsActive } from "../../surfaces/surface-tools.ts";
import type { DeliveryProvenance, Destination, Session, TurnResult } from "../../types.ts";
import { absoluteAppLinks } from "../../util/markdown.ts";
import { heldReplyResult } from "../turn-outcome.ts";
import type { RecordedTurn } from "../turn-resume.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

export async function replayRecordedAnswer(
  turn: {
    deps: OrchestratorDeps;
    input: OrchestratorInput;
    conversation: OrchestratorInput["conversation"];
    session: Session;
    strictReadOnly: boolean;
    defaultDestination: Destination | undefined;
    surfaceName: string;
    postProvenance: (deliveryKey: string) => DeliveryProvenance;
    writer: SessionWriter;
    withManagedRosterVersion: <T>(work: () => Promise<T>) => Promise<T>;
    openStoredOutbound: OpenStoredFile;
    audit: (event: Omit<AuditEvent, "at" | "principalId" | "scopeLabel">) => unknown;
  },
  recorded: { items: Item[] },
  recordedTurn: RecordedTurn,
  recordedAnswer: NonNullable<RecordedTurn["answer"]>,
): Promise<TurnResult> {
  const { deps, input, conversation, session, strictReadOnly, defaultDestination, surfaceName, postProvenance, audit } =
    turn;
  audit({
    action: "turn.already_answered",
    resource: conversation.threadRef,
    detail: `attempt ${input.attempt}; replaying the answer the previous attempt recorded at seq ${recordedAnswer.seq}`,
  });
  console.error(
    `[orchestrator] turn.already_answered attempt=${input.attempt} run=${input.runId} thread=${conversation.threadRef} answerSeq=${recordedAnswer.seq}`,
  );
  const stopped = recordedAnswer.stopped ? { stopped: true } : {};
  const surfaceTools = surfaceToolsActive({ input, strictReadOnly, defaultDestination });
  const held = heldReplyResult({
    sessionId: session.id,
    stopped: recordedAnswer.stopped === true,
    runCancelled: recordedAnswer.cancelled === true,
    surfaceTools,
  });
  const text = absoluteAppLinks(recordedAnswer.text, deps.publicWebUrl);
  if (held) {
    if (surfaceTools && !recordedAnswer.stopped)
      await replayRecordedSurfaceAnswer({
        deps,
        input,
        session,
        defaultDestination,
        surfaceName,
        turnItems: recorded.items,
        userSeq: recordedTurn.userSeq,
        text,
        postProvenance,
      });
    return held;
  }
  const restored = await restoreAttachmentState(
    recorded.items,
    input.runId,
    deps.blobTransfer,
    turn.openStoredOutbound,
    input.actor.id,
  );
  const attachments = restored.entries.map((entry) => entry.attachment);
  if (attachments.length)
    await turn.withManagedRosterVersion(() =>
      recordReplyFiles(deps.sessions, turn.writer, attachments, recorded.items, attachmentSnapshot(restored)),
    );
  return text.trim() || attachments.length
    ? {
        status: "ok",
        sessionId: session.id,
        reply: text,
        ...(attachments.length ? { attachments } : {}),
        sourceUserSeq: recordedTurn.userSeq,
        sourceAssistantEntrySeq: recordedAnswer.seq,
        ...stopped,
      }
    : { status: "silent", sessionId: session.id, ...stopped };
}
