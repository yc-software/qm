import type { Tenant } from "../../tenants/context.ts";
import type { AgentTurnResult } from "../../agent/agent.ts";
import type { MemoryProvenance } from "../../memory/facts.ts";
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

export function startMemoryCapture(turn: {
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
  pausing: boolean;
  cancelStopped: boolean;
  personConversationTurn: boolean;
  useMemory: boolean;
  captureDependencies: () => MemoryProvenance[];
  turnInput: string;
  reply: string;
  spine: SpineState;
}): void {
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
    onTurnEnd
  ) {
    const prior = pendingCaptures.get(memoryScopeId);
    const capture = (async () => {
      if (prior) await prior.catch(swallowAs("prior memory capture", undefined));
      try {
        await onTurnEnd({
          scopeId: memoryScopeId,
          conversationScopeId: scopeId,
          ...(audienceScopeId ? { audienceScopeId } : {}),
          inheritedFacts: captureDependencies(),
          input: turnInput,
          reply,
          actorId: actor.id,
          sessionId: session.id,
          idempotencyKey: input.runId ?? `${session.id}:${spine.turnUserEntrySeq ?? "turn"}`,
        });
      } catch (e) {
        deps.errors.record(
          tenant,
          {
            category: "memory",
            code: "capture_failed",
            message: errMessage(e),
            scopeLabel: scopeId,
            sessionId: session.id,
          },
          e,
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
