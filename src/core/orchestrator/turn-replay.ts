import { collectNamedOutbound, MAX_OUTBOUND_FILES, type OpenStoredFile } from "../attachments.ts";
import { recordReplyFiles } from "./settle.ts";
import { isObj } from "../../util/objects.ts";
import type { SessionWriter } from "../../sessions/session-store.ts";
import type { AuditEvent } from "../../audit/audit-log.ts";
import type { Item } from "../../sessions/items.ts";
import { replayRecordedSurfaceAnswer, surfaceToolsActive } from "../../surfaces/surface-tools.ts";
import type { DeliveryProvenance, Destination, Session, TurnResult } from "../../types.ts";
import { absoluteAppLinks } from "../../util/markdown.ts";
import { heldReplyResult } from "../turn-outcome.ts";
import type { RecordedTurn } from "../turn-resume.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

export async function restoreReplyAttachments(
  deps: Pick<OrchestratorDeps, "files" | "blobTransfer">,
  items: readonly Item[],
  runId: string | undefined,
  openStored: OpenStoredFile,
  staged: NonNullable<TurnResult["attachments"]> = [],
): Promise<NonNullable<TurnResult["attachments"]>> {
  if (!runId) return staged;
  const ids = (delivered: boolean) => [
    ...new Set(
      items.flatMap((item) =>
        item.turnId === runId &&
        Array.isArray(item.body.files) &&
        (delivered
          ? item.kind === "AgentMessage" && item.variant === "files_delivered"
          : item.kind === "ToolResult" && item.tool === "attach" && item.body.ok === true && item.isError !== true)
          ? item.body.files.flatMap((file) =>
              isObj(file) && typeof file.artifactId === "string" && file.artifactId ? [file.artifactId] : [],
            )
          : [],
      ),
    ),
  ];
  const completed = ids(true);
  const current = new Set(staged.flatMap((file) => file.artifactId ?? []));
  const candidates = (completed.length ? completed : ids(false)).filter((id) => !current.has(id));
  if (!candidates.length) return staged;
  const available = new Set((await deps.files.getMany(candidates)).map((file) => file.id));
  if (completed.some((id) => !current.has(id) && !available.has(id)))
    throw new Error("Previously attached files are no longer available.");
  const selected = candidates.filter((id) => available.has(id));
  if (!selected.length) return staged;
  if (selected.length + staged.length > MAX_OUTBOUND_FILES)
    throw new Error(`Reply attachments exceed the ${MAX_OUTBOUND_FILES}-file limit.`);
  const restored = await collectNamedOutbound(
    undefined,
    undefined,
    selected.map((file_id) => ({ file_id })),
    deps.blobTransfer,
    undefined,
    [],
    openStored,
  );
  if (restored.missing.length || restored.empty.length || restored.oversized.length)
    throw new Error("Previously attached files are no longer available.");
  return [...restored.attachments, ...staged];
}

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
  const attachments = await restoreReplyAttachments(deps, recorded.items, input.runId, turn.openStoredOutbound);
  if (attachments.length)
    await turn.withManagedRosterVersion(() =>
      recordReplyFiles(deps.sessions, turn.writer, attachments, recorded.items),
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
