import { randomUUID } from "node:crypto";
import type { AgentTurnInput, TurnLlmRequestRecord } from "../../agent/agent.ts";
import { reportFailure } from "../../util/errors.ts";
import { securityScreenChunks } from "../../security/security-posture.ts";
import type { AttachmentMeta, Session } from "../../types.ts";
import type { ArtifactRegistration } from "../attachments.ts";
import type { DocumentInput } from "../documents.ts";
import { introducesUser, isSessionTurn, midTurnSessionMessage } from "../turn-origin.ts";
import { cleanVerdict, screenChunks, type ClassifyAs, type InboundScreenTurn } from "./security-screen.ts";
import type { Orchestrator, OrchestratorDeps, OrchestratorInput } from "./types.ts";
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

function speakerName(speaker: Speaker, nameOf: (id: string) => string | undefined): string {
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

function midTurnPrompt(
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

export async function recordUser(
  users: OrchestratorDeps["users"],
  id: string,
  botActor: boolean | undefined,
): Promise<void> {
  try {
    await users.record({ id, source: "turn", at: Date.now() });
    if (botActor) await users.markApps([id]);
  } catch (err) {
    reportFailure("users: record user", err);
  }
}

export interface SteerTurn {
  deps: OrchestratorDeps;
  orchestrator: Orchestrator;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  conversation: OrchestratorInput["conversation"];
  session: Session;
  securityPolicy: InboundScreenTurn["resolution"]["securityPolicy"];
  nameOf: (id: string) => string | undefined;
  speakerLine: (speaker: Speaker) => string;
  classifyAs: ClassifyAs;
  recordScreenRequest: (rec: TurnLlmRequestRecord) => Promise<void>;
  takeIn: (
    message: IncomingMessage,
    registration: ArtifactRegistration,
    inboxDir: string,
  ) => Promise<ReturnType<typeof intakeOf>>;
  fileRegistration: ArtifactRegistration;
  turnInboxDir: string;
  ingestDocuments: (
    metas: readonly AttachmentMeta[],
    requestText: string,
    existingDocuments?: readonly DocumentInput[],
  ) => Promise<{ documents: DocumentInput[]; notices: string[]; unscreened: boolean }>;
  initialDocuments: readonly DocumentInput[];
  documentInputs: { documents: DocumentInput[] };
}

export function createSteerPreparer(turn: SteerTurn): NonNullable<AgentTurnInput["prepareSteer"]> {
  const {
    deps,
    orchestrator,
    input,
    actor,
    conversation,
    session,
    securityPolicy,
    nameOf,
    speakerLine,
    classifyAs,
    recordScreenRequest,
    takeIn,
    fileRegistration,
    turnInboxDir,
    ingestDocuments,
    initialDocuments,
    documentInputs,
  } = turn;
  return async (text, request) => {
    const steerer = request ? deps.identity.resolve(request.actor) : actor;
    const author = steerer.id;
    const speaker: Speaker = request
      ? {
          id: author,
          ...(request.actor.displayName ? { name: request.actor.displayName } : {}),
          origin: request.origin ?? { kind: "automation", screenData: text },
          fromSession: isSessionTurn(request),
        }
      : {
          id: author,
          ...(actor.displayName ? { name: actor.displayName } : {}),
          origin: { kind: "direct" },
          fromSession: false,
        };
    const by = {
      author,
      ...(samePerson(author, actor.id) ? {} : { authorName: speakerName(speaker, nameOf) }),
    };
    let said =
      request?.sessionSenderId && request.text.trim()
        ? midTurnSessionMessage(request.text, request.sessionSenderId === session.parentSessionId)
        : [text.trim() ? speakerLine(speaker) : "", text].filter(Boolean).join("\n");
    const screened = [wordsToScreen(said, speaker, actor.id), ...(request?.inboundNotes ?? [])]
      .filter(Boolean)
      .join("\n\n");
    if (screened) {
      const screen = await orchestrator
        .screenSecuritySteer({ payload: screened, actor: steerer, conversation, sessionId: session.id })
        .catch((error: unknown) => {
          reportFailure("orchestrator: mid-turn message screen", error);
          return undefined;
        });
      if (!screen || screen === "block")
        return {
          text: screen
            ? "A mid-turn message was withheld by the security screen."
            : "A mid-turn message was withheld because the security screen could not check it.",
          author,
          authorName: speakerName(speaker, nameOf),
          withheld: true,
        };
      if (screen === "unscreened") said = `${unscreenedNotice("mid-turn message")}\n${said}`;
    }
    if (request && introducesUser(speaker.origin, request)) await recordUser(deps.users, author, request.botActor);
    const refreshedInbox =
      input.surface === "web" &&
      conversation.kind === "dm" &&
      /^web:.+:inbox$/.test(conversation.threadRef) &&
      request?.conversation.threadRef === conversation.threadRef
        ? request.conversationHeader?.trim()
        : undefined;
    if (refreshedInbox) {
      let allowed = true;
      if (securityPolicy.screening !== "off") {
        const verdict = await screenChunks(
          securityScreenChunks("conversation-header", refreshedInbox),
          classifyAs(
            { sessionId: session.id, hook: "user_input", request: text, surface: "steer" },
            recordScreenRequest,
          ),
          { stopUnclean: true },
        );
        allowed = cleanVerdict(verdict);
      }
      said = `${said}\n\n${allowed ? refreshedInbox : "Updated inbox context was withheld by the security screen."}`;
    }
    if (!request?.attachments?.length && !request?.inboundNotes?.length) return { text: said, ...by };
    const intake = await takeIn(
      {
        text,
        ...(request.attachments ? { attachments: request.attachments } : {}),
        ...(request.actor.displayName ? { sharer: request.actor.displayName } : {}),
        ...(request.inboundNotes ? { notes: request.inboundNotes } : {}),
      },
      { ...fileRegistration, seed: `${fileRegistration.seed}:steer:${randomUUID()}` },
      `${turnInboxDir}/${randomUUID()}`,
    );
    const steeredDocuments = await ingestDocuments(intake.received.metas, text, initialDocuments);
    documentInputs.documents.push(...steeredDocuments.documents);
    return {
      text: midTurnPrompt(said, intake, steeredDocuments),
      attachments: intake.received.metas,
      images: intake.received.images,
      documents: steeredDocuments.documents,
      ...by,
    };
  };
}
