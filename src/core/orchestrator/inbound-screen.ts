import { securityScreenPayloads } from "../../security/security-screen.ts";
import { collectBlob } from "../../persistence/blob-transfer.ts";
import { isVisionAttachment, safeAttachmentName, senderNote } from "../attachments.ts";
import { renderOverheard, selectOverheardToImport, type OverheardEntryPayload } from "../../harness/replay.ts";
import { swallowAs } from "../../util/errors.ts";
import type { OrchestratorDeps } from "./types.ts";
import { MAX_AUTO_ATTACHMENT_SCREEN_BYTES, isScreenableTextAttachment } from "./turn-helpers.ts";

import type { TurnCtx } from "./turn-context.ts";
import type { SecurityObserver } from "./security-screen.ts";

export interface ScreenTrace {
  readonly thread: string;
  readonly runId?: string;
}

export function observeInboundTurn(
  ctx: TurnCtx,
  services: { observeSecurityData: SecurityObserver; blobTransfer: OrchestratorDeps["blobTransfer"] },
): ScreenTrace {
  const { deps, input, actor, conversation, ambientTurn, sessionTurn, scopeId } = ctx;
  const { observeSecurityData, blobTransfer } = services;
  const screenTrace: ScreenTrace = {
    thread: conversation.threadRef,
    ...(input.runId ? { runId: input.runId } : {}),
  };
  const observe = async (): Promise<void> => {
    let overheard: OverheardEntryPayload[] = [];
    if (conversation.kind !== "dm" && input.overheard?.length) {
      const existingSession = await deps.sessions.getByThread(conversation.threadRef);
      const incoming = input.overheard.flatMap((m) => (typeof m.ts === "string" && m.ts ? [m.ts] : []));
      const recorded = existingSession
        ? await deps.sessions.recordedMessageTimestamps(existingSession.id, incoming)
        : new Set<string>();
      overheard = selectOverheardToImport(input.overheard, recorded);
    }
    const attachmentPromptData: Array<{ source: string; content: string }> = [];
    for (const attachment of input.attachments ?? []) {
      attachmentPromptData.push({
        source: "attachment-metadata",
        content: JSON.stringify({
          name: attachment.name,
          mimetype: attachment.mimetype,
          author: attachment.author,
        }),
      });
      if (
        isVisionAttachment(attachment) ||
        !isScreenableTextAttachment(attachment.mimetype) ||
        attachment.sizeBytes > MAX_AUTO_ATTACHMENT_SCREEN_BYTES
      )
        continue;
      const opened = await blobTransfer
        .open(attachment.blobId)
        .catch(swallowAs("attachment screening: open blob", null));
      if (!opened || opened.sizeBytes > MAX_AUTO_ATTACHMENT_SCREEN_BYTES) continue;
      const data = await collectBlob(opened.stream).catch(swallowAs("attachment screening: read blob", null));
      if (!data || data.length > MAX_AUTO_ATTACHMENT_SCREEN_BYTES || data.includes(0)) continue;
      attachmentPromptData.push({
        source: `attachment:${safeAttachmentName(attachment.name)}`,
        content: data.toString("utf8"),
      });
    }
    const externalPromptData = [
      ...(ambientTurn && actor.displayName?.trim()
        ? [{ source: "sender", content: senderNote(actor.displayName) }]
        : []),
      ...(input.conversationHeader?.trim()
        ? [{ source: "conversation-header", content: input.conversationHeader }]
        : []),
      ...overheard.map((entry) => ({ source: "overheard", content: renderOverheard(entry) })),
      ...attachmentPromptData,
      ...(input.inboundNotes ?? []).map((note) => ({ source: "inbound-file-note", content: note })),
    ];
    const sessionSender = input.sessionSenderId ? await deps.sessions.get(input.sessionSenderId) : null;
    const verifiedSessionMessage = Boolean(
      sessionSender &&
      sessionSender.scopeId === scopeId &&
      (await deps.sessions.getForParticipant(sessionSender.id, actor.id)),
    );
    const chunks = securityScreenPayloads({
      ...input,
      origin: sessionTurn ? { kind: "automation", screenData: input.text } : input.origin,
      overheard: [],
      externalPromptData,
      verifiedSessionMessage,
    });
    for (const chunk of chunks)
      await observeSecurityData(chunk, actor.id, scopeId, {
        ...screenTrace,
        hook: "user_input",
        surface: input.surface,
        origin: input.origin.kind,
      });
  };
  void observe().catch(swallowAs("orchestrator: observed inbound screen", undefined));
  return screenTrace;
}
