import type { SessionStore, SessionWriter } from "../../sessions/session-store.ts";
import { isObj } from "../../util/objects.ts";
import type { Tenant } from "../../tenants/context.ts";
import type { AgentTurnResult } from "../../agent/agent.ts";
import type { MemoryCaptureMetadata, MemoryProvenance } from "../../memory/facts.ts";
import type { MemoryPolicy } from "../../memory/policy.ts";
import type { MemoryStrategy } from "../../memory/strategy.ts";
import { isAgentReply, type Item } from "../../sessions/items.ts";
import type { createSurfaceToolDeps, SpineState } from "../../surfaces/surface-tools.ts";
import type { PendingApproval, PendingApprovalRecord, ScopeId, Session, TurnResult } from "../../types.ts";
import { hashId } from "../../util/crypto.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { commandApprovalId } from "../approval-id.ts";
import { approvalBlocksInput, type deriveTurnOutcome, heldReplyResult } from "../turn-outcome.ts";
import type { createApprovalLedger } from "./approvals.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

type QuarantineReleaseApproval = Awaited<ReturnType<typeof createApprovalLedger>>["quarantineReleaseApprovals"][number];

export async function recordReplyFiles(
  sessions: Pick<SessionStore, "append">,
  writer: SessionWriter,
  filesToRecord: readonly Pick<
    NonNullable<TurnResult["attachments"]>[number],
    "artifactId" | "name" | "mimetype" | "sizeBytes" | "artifactViewerId"
  >[],
  previous: readonly Item[],
): Promise<void> {
  if (!filesToRecord.length) return;
  const recorded = new Set(
    previous.flatMap((item) =>
      writer.turnId &&
      item.turnId === writer.turnId &&
      item.kind === "AgentMessage" &&
      item.variant === "files_delivered" &&
      Array.isArray(item.body.files)
        ? item.body.files.flatMap((file) =>
            isObj(file) && typeof file.artifactId === "string" ? [file.artifactId] : [],
          )
        : [],
    ),
  );
  const files = filesToRecord.flatMap((file) => {
    if (!file.artifactId || recorded.has(file.artifactId)) return [];
    recorded.add(file.artifactId);
    return [
      {
        artifactId: file.artifactId,
        name: file.name,
        mimetype: file.mimetype,
        sizeBytes: file.sizeBytes,
        ...(file.artifactViewerId ? { artifactViewerId: file.artifactViewerId } : {}),
      },
    ];
  });
  if (files.length)
    await sessions.append(writer, { kind: "AgentMessage", variant: "files_delivered", body: { files } });
}

export async function startMemoryCapture(turn: {
  tenant: Tenant;
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  session: Session;
  scopeId: ScopeId;
  memoryScopeId: ScopeId;
  audienceScopeId: ScopeId | undefined;
  memoryPolicy: MemoryPolicy;
  pendingCaptures: Map<ScopeId, Promise<void>>;
  onTurnEnd: MemoryStrategy["onTurnEnd"];
  enqueueTurnEnd: MemoryStrategy["enqueueTurnEnd"];
  pausing: boolean;
  cancelStopped: boolean;
  personConversationTurn: boolean;
  useMemory: boolean;
  captureDependencies: () => MemoryProvenance[];
  document?: MemoryCaptureMetadata["document"];
  turnInput: string;
  reply: string;
  spine: SpineState;
}): Promise<void> {
  const {
    tenant,
    deps,
    input,
    actor,
    session,
    scopeId,
    memoryScopeId,
    audienceScopeId,
    memoryPolicy,
    pendingCaptures,
    onTurnEnd,
    enqueueTurnEnd,
    pausing,
    cancelStopped,
    personConversationTurn,
    useMemory,
    captureDependencies,
    turnInput,
    reply,
    spine,
  } = turn;
  if (
    !pausing &&
    !cancelStopped &&
    personConversationTurn &&
    useMemory &&
    memoryPolicy.capture !== "off" &&
    (onTurnEnd || enqueueTurnEnd)
  ) {
    const current = await deps.sessions.get(session.id);
    if (!current) return;
    if (current.personalOnly) session.personalOnly = true;
    session.sourceProvenance = current.sourceProvenance;
    const context = {
      scopeId: memoryScopeId,
      ...(session.personalOnly ? { personalOnly: true as const } : {}),
      ...(turn.document
        ? { document: turn.document, ...(turn.document.mode === "private" ? { personalOnly: true as const } : {}) }
        : {}),
      conversationScopeId: scopeId,
      ...(audienceScopeId ? { audienceScopeId } : {}),
      inheritedFacts: [...captureDependencies(), ...(session.sourceProvenance ? [session.sourceProvenance] : [])],
      input: turnInput,
      reply,
      actorId: actor.id,
      sessionId: session.id,
      idempotencyKey: input.runId ?? `${session.id}:${spine.turnUserEntrySeq ?? "turn"}`,
    };
    if (enqueueTurnEnd) {
      try {
        await enqueueTurnEnd(context);
      } catch (error) {
        deps.errors.record(
          tenant,
          {
            category: "memory",
            code: "capture_handoff_failed",
            message: errMessage(error),
            scopeLabel: scopeId,
            sessionId: session.id,
          },
          error,
        );
        throw error;
      }
      return;
    }
    if (!onTurnEnd) return;
    const prior = pendingCaptures.get(memoryScopeId);
    const capture = (async () => {
      if (prior) await prior.catch(swallowAs("prior memory capture", undefined));
      try {
        await onTurnEnd(context);
      } catch (error) {
        deps.errors.record(
          tenant,
          {
            category: "memory",
            code: "capture_failed",
            message: errMessage(error),
            scopeLabel: scopeId,
            sessionId: session.id,
          },
          error,
        );
      }
    })();
    pendingCaptures.set(memoryScopeId, capture);
    void capture.finally(() => {
      if (pendingCaptures.get(memoryScopeId) === capture) pendingCaptures.delete(memoryScopeId);
    });
  }
}

export async function selectTurnResult(turn: {
  input: OrchestratorInput;
  session: Session;
  scopeId: ScopeId;
  result: AgentTurnResult;
  outcome: ReturnType<typeof deriveTurnOutcome>;
  reply: string;
  turnCompleted: boolean;
  cancelStopped: boolean;
  replyOptional: boolean;
  stagedAttachments: NonNullable<TurnResult["attachments"]>;
  quarantineReleaseApprovals: QuarantineReleaseApproval[];
  surfaceToolDeps: ReturnType<typeof createSurfaceToolDeps>;
  strictReadOnly: boolean;
  wornPersona: TurnResult["persona"];
  turnUserSeq: number | undefined;
  emittedEntries: Item[];
  approvalSummary: (scopeId: ScopeId, command: string, reason: string, purpose?: string) => Promise<string | undefined>;
  issueApproval: (
    requestId: string,
    fields: Omit<PendingApprovalRecord, "createdAt" | "request">,
  ) => Promise<PendingApproval>;
  withManagedRosterVersion: <T>(work: () => Promise<T>) => Promise<T>;
}): Promise<TurnResult> {
  const {
    input,
    session,
    scopeId,
    result,
    outcome,
    reply,
    turnCompleted,
    cancelStopped,
    replyOptional,
    stagedAttachments,
    quarantineReleaseApprovals,
    surfaceToolDeps,
    strictReadOnly,
    wornPersona,
    turnUserSeq,
    emittedEntries,
    approvalSummary,
    issueApproval,
    withManagedRosterVersion,
  } = turn;
  let finalResult: TurnResult;
  const stopScope = result.stopScope ? { stopScope: result.stopScope } : {};
  const sourceUserSeq = turnUserSeq;
  const sourceAssistantEntrySeq = emittedEntries.findLast(isAgentReply)?.seq;
  const heldReply = (runCancelled: boolean, surfaceTools: boolean) =>
    heldReplyResult({
      sessionId: session.id,
      stopped: result.stopped === true,
      ...(result.stopScope ? { stopScope: result.stopScope } : {}),
      runCancelled,
      surfaceTools,
    });
  if (cancelStopped && !result.pendingApprovals?.length) {
    finalResult = heldReply(true, false)!;
  } else if (replyOptional && result.silent && !stagedAttachments.length && result.pausedOnApproval !== true) {
    finalResult = { status: "silent", sessionId: session.id };
  } else if (result.pendingApprovals?.length || quarantineReleaseApprovals.length) {
    const issued: Array<[string, Omit<PendingApprovalRecord, "createdAt" | "request">]> = [];
    const turnApprovals: Array<
      NonNullable<AgentTurnResult["pendingApprovals"]>[number] & {
        summary?: string;
        summaryDetail?: string;
        screenedOutput?: PendingApprovalRecord["screenedOutput"];
        grantModes?: { session: boolean; always: boolean };
      }
    > = [...(result.pendingApprovals ?? []), ...quarantineReleaseApprovals];
    for (const pa of turnApprovals) {
      const requestId = commandApprovalId(
        session.id,
        pa.screenedOutput
          ? `${pa.command}:${hashId([pa.screenedOutput.tool, pa.screenedOutput.text, pa.screenedOutput.sourceScopeId ?? scopeId], 64)}`
          : pa.command,
        pa.approvalKey,
      );
      issued.push([
        requestId,
        {
          sessionId: session.id,
          command: pa.command,
          reason: pa.reason,
          blocksInput: approvalBlocksInput(pa.kind, outcome),
          grantModes: pa.grantModes,
          matched: pa.matched,
          purpose: pa.purpose,
          summary: pa.summary ?? (await approvalSummary(scopeId, pa.command, pa.reason, pa.purpose)),
          summaryDetail: pa.summaryDetail,
          screenedOutput: pa.screenedOutput,
          approvalKey: pa.approvalKey,
          kind: pa.kind,
          call: pa.call,
        },
      ]);
    }
    const approvals = await withManagedRosterVersion(async () => {
      const issuedApprovals: PendingApproval[] = [];
      for (const [requestId, fields] of issued) issuedApprovals.push(await issueApproval(requestId, fields));
      return issuedApprovals;
    });
    finalResult = turnCompleted
      ? {
          status: "ok",
          sessionId: session.id,
          reply,
          pendingApprovals: approvals,
          ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
          ...(sourceUserSeq !== undefined ? { sourceUserSeq } : {}),
          ...(sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq } : {}),
        }
      : { status: "pending_approval", sessionId: session.id, pendingApprovals: approvals };
  } else if (replyOptional && !stagedAttachments.length && !reply.trim()) {
    finalResult = { status: "silent", sessionId: session.id };
  } else if (input.surfaceTools && surfaceToolDeps && !strictReadOnly) {
    finalResult = heldReply(false, true)!;
  } else {
    finalResult = {
      status: "ok",
      sessionId: session.id,
      reply,
      ...(result.retracted?.length ? { retracted: result.retracted } : {}),
      ...(wornPersona ? { persona: wornPersona } : {}),
      ...(result.stopped ? { stopped: true, ...stopScope } : {}),
      ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
      ...(sourceUserSeq !== undefined ? { sourceUserSeq } : {}),
      ...(sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq } : {}),
    };
  }
  return finalResult;
}
