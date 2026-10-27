import { surfaceHas } from "../../surfaces/surface.ts";
import type { OutgoingAttachment } from "../../types.ts";
import type { TurnOutcome } from "../turn-outcome.ts";
import type { MemoryStrategy } from "../../memory/strategy.ts";
import type { MemoryPolicy } from "../../memory/policy.ts";
import { ProjectRosterChanged, rosterChangedRefusal } from "./admit.ts";
import { parkApprovals, summarizeApproval, type ApprovalRequest } from "./approvals.ts";
import type { TurnCtx } from "./turn-context.ts";
import type { Session } from "../../types.ts";
import type { MemoryProvenance } from "../../memory/facts.ts";
import type { PartialTurn } from "../turn-resume.ts";
import { type ScopeId, type TurnResult } from "../../types.ts";
import { deriveTurnOutcome, approvalBlocksInput } from "../turn-outcome.ts";
import type { Lease } from "../../sessions/session-store.ts";
import { isReply, isUserMessage, type Item, type NewItem } from "../../sessions/items.ts";
import type { HarnessTurnResult } from "../../harness/harness.ts";
import { commandApprovalId } from "../approval-id.ts";
import { NeedsApproval, CommandDenied } from "../../tools/primitives.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import {
  isModelBudget,
  isNonRetryable,
  ProviderTurnError,
  turnFailureMessage,
  turnFailureItem,
} from "../turn-error.ts";
import { stripAckPrefix } from "./turn-helpers.ts";
import { type SpineState } from "./surface-tools.ts";
import { createAttachStaging } from "./attach-tool.ts";

export async function settleTurnResult(
  ctx: TurnCtx,
  turn: {
    session: Session;
    hasSurfaceToolDeps: boolean;
    isPollFire: boolean;
    emittedEntries: Item[];
    result: HarnessTurnResult;
    stagedAttachments: OutgoingAttachment[];
    reply: string;
    cancelStopped: boolean;
    outcome: TurnOutcome;
    turnCompleted: boolean;
    turnUserSeq: number | undefined;
  },
): Promise<TurnResult> {
  const { deps, input, withManagedRosterVersion, approvalOwner, strictReadOnly } = ctx;
  const {
    session,
    hasSurfaceToolDeps,
    isPollFire,
    emittedEntries,
    result,
    stagedAttachments,
    reply,
    cancelStopped,
    outcome,
    turnCompleted,
    turnUserSeq,
  } = turn;
  const pending = deps.approvals;
  let finalResult: TurnResult;
  const sourceUserSeq = turnUserSeq;
  const sourceAssistantEntrySeq = emittedEntries.findLast(isReply)?.seq;
  if (cancelStopped && !result.pendingApprovals?.length) {
    finalResult = { status: "silent", sessionId: session.id, stopped: true };
  } else if (isPollFire && result.silent && !stagedAttachments.length && result.pausedOnApproval !== true) {
    finalResult = { status: "silent", sessionId: session.id };
  } else if (result.pendingApprovals?.length) {
    const turnApprovals: Array<
      NonNullable<HarnessTurnResult["pendingApprovals"]>[number] & {
        summary?: string;
        summaryDetail?: string;
        grantModes?: { session: boolean; always: boolean };
      }
    > = [...(result.pendingApprovals ?? [])];
    const requests: ApprovalRequest[] = [];
    for (const pa of turnApprovals)
      requests.push(await approvalRequest(ctx, session.id, pa, approvalBlocksInput(pa.kind, outcome)));
    const approvals = await withManagedRosterVersion(() => parkApprovals(pending, approvalOwner(session.id), requests));
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
  } else if (isPollFire && !stagedAttachments.length && !reply.trim()) {
    finalResult = { status: "silent", sessionId: session.id };
  } else if (input.surfaceTools && hasSurfaceToolDeps && !strictReadOnly) {
    finalResult = { status: "silent", sessionId: session.id, ...(result.stopped ? { stopped: true } : {}) };
  } else {
    finalResult = {
      status: "ok",
      sessionId: session.id,
      reply,
      ...(result.stopped ? { stopped: true } : {}),
      ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
      ...(sourceUserSeq !== undefined ? { sourceUserSeq } : {}),
      ...(sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq } : {}),
    };
  }
  return finalResult;
}

type ApprovalAsk = Omit<ApprovalRequest, "requestId" | "blocksInput">;

async function approvalRequest(
  ctx: TurnCtx,
  sessionId: string,
  ask: ApprovalAsk,
  blocksInput: boolean,
): Promise<ApprovalRequest> {
  const summary = ask.summary ?? (await summarizeApproval(ctx.deps, ctx.scopeId, ask.command, ask.reason, ask.purpose));
  return {
    ...ask,
    requestId: commandApprovalId(sessionId, ask.command, ask.approvalKey),
    blocksInput,
    ...(summary ? { summary } : {}),
  };
}

export async function mapTurnFailure(
  ctx: TurnCtx,
  turn: { session: Session; lease: Lease; failureUserItem: NewItem<"UserMessage"> | undefined },
  err: unknown,
): Promise<TurnResult> {
  const { deps, input, withManagedRosterVersion, approvalOwner, scopeId } = ctx;
  const { session, lease, failureUserItem } = turn;
  const pending = deps.approvals;
  if (err instanceof ProjectRosterChanged) {
    return rosterChangedRefusal(session.id);
  }
  if (err instanceof NeedsApproval) {
    const request = await approvalRequest(
      ctx,
      session.id,
      {
        command: err.command,
        reason: err.approvalReason,
        grantModes: { session: err.grantModes?.session ?? true, always: err.grantModes?.always ?? true },
        ...(err.matched ? { matched: err.matched } : {}),
        ...(err.approvalKey ? { approvalKey: err.approvalKey } : {}),
        ...(err.kind ? { kind: err.kind } : {}),
      },
      true,
    );
    try {
      const pendingApprovals = await withManagedRosterVersion(() =>
        parkApprovals(pending, approvalOwner(session.id), [request]),
      );
      return { status: "pending_approval", sessionId: session.id, pendingApprovals };
    } catch (writeErr) {
      if (writeErr instanceof ProjectRosterChanged) {
        return rosterChangedRefusal(session.id);
      }
      throw writeErr;
    }
  }
  if (err instanceof CommandDenied) {
    deps.errors?.record({
      category: "command_policy",
      code: "denied",
      message: err.message,
      scopeLabel: scopeId,
      sessionId: session.id,
    });
    return { status: "refused", sessionId: session.id, reason: err.message };
  }
  const budget = isModelBudget(err) && !input.cancel?.aborted;
  deps.errors?.record(
    {
      category: "turn",
      code: budget ? "model_budget" : "error",
      message: err instanceof ProviderTurnError ? err.raw : errMessage(err),
      scopeLabel: scopeId,
      sessionId: session.id,
    },
    err,
  );
  if ((isNonRetryable(err) || input.finalAttempt) && !input.cancel?.aborted) {
    if (failureUserItem) {
      await deps.sessions
        .append(lease, failureUserItem)
        .catch(swallowAs("orchestrator: turn failure user back-fill", undefined));
    }
    await deps.sessions
      .append(lease, turnFailureItem(turnFailureMessage(err), input.runId))
      .catch(swallowAs("orchestrator: terminal turn failure record", undefined));
  }
  if (budget)
    return {
      status: "refused",
      sessionId: session.id,
      reason: turnFailureMessage(err),
      refusalKind: "model_budget",
    };
  throw err;
}

export async function concludeTurn(
  ctx: TurnCtx,
  turn: {
    session: Session;
    result: HarnessTurnResult;
    attachStaging: ReturnType<typeof createAttachStaging>;
    spine: SpineState;
    partial: PartialTurn | null;
    turnInput: string;
    emittedEntries: Item[];
    memoryScopeId: ScopeId;
    captureDependencies: () => MemoryProvenance[];
    memoryStrategy: MemoryStrategy;
    memoryPolicy: MemoryPolicy;
  },
) {
  const { deps, input, actor, automatedTurn, scopeId, useMemory } = ctx;
  const {
    session,
    result,
    attachStaging,
    spine,
    partial,
    turnInput,
    emittedEntries,
    memoryScopeId,
    captureDependencies,
    memoryStrategy,
    memoryPolicy,
  } = turn;
  const stagedAttachments = attachStaging.staged();
  const harvestedAck = (() => {
    if (!surfaceHas(input.surface, "earlyAck") || input.surfaceTools || !input.runId) return undefined;
    const fb = deps.turnStream?.firstBlock(input.runId);
    const text = fb?.text.trim();
    return fb?.closed && text ? text : undefined;
  })();
  const reply = stripAckPrefix(result.reply ?? "", harvestedAck);
  const cancelStopped = input.cancel?.aborted === true && result.stopped === true;

  const outcome = deriveTurnOutcome({
    ...(reply !== undefined ? { reply } : {}),
    attachments: stagedAttachments.length,
    pendingApprovals: result.pendingApprovals ?? [],
    terminatedOnApproval: result.pausedOnApproval === true,
  });
  const turnCompleted = outcome.completed;
  const pausing = outcome.paused;
  if (input.runId && !pausing && reply && reply.trim()) deps.turnStream?.markReplyDone(input.runId);
  const turnUserSeq = partial?.userSeq ?? emittedEntries.find(isUserMessage)?.seq;
  const onTurnEnd = memoryStrategy.onTurnEnd?.bind(memoryStrategy);
  if (!pausing && !cancelStopped && useMemory && memoryPolicy.capture !== "off" && onTurnEnd) {
    try {
      await onTurnEnd({
        scopeId: memoryScopeId,
        conversationScopeId: scopeId,
        inheritedFacts: captureDependencies(),
        input: turnInput,
        reply,
        actorId: actor.id,
        ...(automatedTurn ? { autonomous: true } : {}),
        sessionId: session.id,
        idempotencyKey: input.runId ?? `${session.id}:${spine.turnUserEntrySeq ?? "turn"}`,
      });
    } catch (e) {
      deps.errors?.record(
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
  }
  return { stagedAttachments, reply, cancelStopped, outcome, turnCompleted, pausing, turnUserSeq };
}
