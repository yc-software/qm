import { samePerson } from "../../directory/person.ts";
import { unscreenedNotice } from "../../security/security-posture.ts";
import type { ConversationKind, IncomingAttachment } from "../../types.ts";
import {
  inboundIssueList,
  inboundIssuesNote,
  inboundManifest,
  safeAttachmentName,
  type materializeInbound,
} from "../attachments.ts";
import type { TurnOrigin } from "../turn-origin.ts";
import { senderNote } from "./prompt-blocks.ts";
import { isScreenableTextAttachment } from "./turn-helpers.ts";

export interface IncomingMessage {
  text: string;
  attachments?: IncomingAttachment[];
  sharer?: string;
  notes?: readonly string[];
}

export interface Speaker {
  id: string;
  name?: string;
  origin: TurnOrigin;
  fromSession: boolean;
}

export function senderLine(
  turn: { conversationKind: ConversationKind; ownerId: string },
  speaker: Speaker,
  nameOf: (id: string) => string | undefined,
): string {
  if (speaker.origin.kind === "automation" || speaker.fromSession) return "";
  if (turn.conversationKind === "dm" && samePerson(speaker.id, turn.ownerId)) return "";
  return senderNote(speakerName(speaker, nameOf));
}

export function speakerName(speaker: Speaker, nameOf: (id: string) => string | undefined): string {
  return ([speaker.name, nameOf(speaker.id)].find((name) => name?.trim()) ?? speaker.id).trim();
}

export function wordsToScreen(said: string, speaker: Speaker, ownerId: string): string | undefined {
  let words: string | undefined;
  if (speaker.fromSession) words = said;
  else if (speaker.origin.kind === "automation") words = speaker.origin.screenData;
  else if (!samePerson(speaker.id, ownerId)) words = said;
  return words?.trim() ? words : undefined;
}

type Received = Awaited<ReturnType<typeof materializeInbound>>;

export function intakeOf(
  received: Received,
  message: IncomingMessage,
  inboxDir: string,
  posture: { strictReadOnly: boolean; enforceScreen: boolean },
) {
  return {
    received,
    manifest: inboundManifest(received.metas, inboxDir, received.unstaged, message.sharer),
    issues: inboundIssueList({
      tooMany: received.tooMany,
      unavailable: received.unavailable,
      blocked: received.blocked,
      surfaceNotes: [
        ...(message.notes ?? []),
        ...(posture.strictReadOnly
          ? (message.attachments ?? []).map(
              (attachment) => `${safeAttachmentName(attachment.name)} — unavailable in Strict posture`,
            )
          : []),
      ],
    }),
    unscreened:
      posture.enforceScreen &&
      (received.unscreened.length > 0 || received.metas.some((meta) => !isScreenableTextAttachment(meta.mimetype))),
  };
}

export function midTurnPrompt(
  said: string,
  intake: ReturnType<typeof intakeOf>,
  documents: { notices: readonly string[]; unscreened: boolean },
): string {
  return [
    said,
    intake.manifest,
    ...documents.notices,
    inboundIssuesNote(intake.issues),
    intake.unscreened || documents.unscreened ? unscreenedNotice("inbound content") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
