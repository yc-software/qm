import type { ApprovedToolCall, SteeredApproval } from "../../agent/agent.ts";
import { samePerson } from "../../directory/person.ts";
import type { DurableMap } from "../../persistence/durable-map.ts";
import type { Item } from "../../sessions/items.ts";
import type { ApprovalGrantModes, PendingApproval, PendingApprovalRecord, TurnRequest } from "../../types.ts";
import { approvalCardId, approvedCallId } from "../approval-id.ts";

export function grantModesWithin(
  allowed: ApprovalGrantModes,
  requested: ApprovalGrantModes | undefined,
): { grantModes?: ApprovalGrantModes } {
  const session = allowed.session && (requested?.session ?? true);
  const always = allowed.always && (requested?.always ?? true);
  return session && always ? {} : { grantModes: { session, always } };
}

export function approvalView(requestId: string, record: PendingApprovalRecord): PendingApproval {
  return {
    requestId,
    command: record.command,
    reason: record.reason ?? "requires approval",
    blocksInput: record.blocksInput !== false,
    ...(record.grantModes ? { grantModes: record.grantModes } : {}),
    ...(record.matched ? { matched: record.matched } : {}),
    ...(record.purpose ? { purpose: record.purpose } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.summaryDetail ? { summaryDetail: record.summaryDetail } : {}),
    ...(record.approvalKey ? { approvalKey: record.approvalKey } : {}),
    ...(record.kind ? { kind: record.kind } : {}),
    ...executesOnApprove(record),
  };
}

export const APPROVED_CALL_RAN_NOTE =
  "The requesting human approved the pending call, and QM has already attempted it exactly as approved; its result, or the error that stopped it, is recorded just before this message. Do not call it again. Continue the original task from that result. All other permission and screening checks remain in force.";

export const APPROVAL_DECISION_SIGNAL_TEXT = "[approval decision]";

export function executesOnApprove(record: Pick<PendingApprovalRecord, "call">): { executesOnApprove?: true } {
  return record.call ? { executesOnApprove: true } : {};
}

export type ApprovalRefusal = "expired" | "foreign_session" | "not_requester";

export function approvalRefusal(
  record: PendingApprovalRecord | null | undefined,
  sessionId: string,
  clickerId: string,
): ApprovalRefusal | undefined {
  if (!record) return "expired";
  if (record.sessionId !== sessionId) return "foreign_session";
  if (!samePerson(record.request?.actor.externalId, clickerId)) return "not_requester";
  return undefined;
}

export function approvedToolCall(requestId: string, record: PendingApprovalRecord): ApprovedToolCall | undefined {
  return record.call
    ? { callId: approvedCallId(requestId, record.createdAt ?? 0), requestId, ...record.call }
    : undefined;
}

type ApprovalAudit = (event: { action: string; resource: string; status: "ok" | "refused"; detail?: string }) => void;

export async function resolveLiveApproval(
  request: TurnRequest,
  ctx: {
    pending: DurableMap<PendingApprovalRecord>;
    sessionId: string;
    clickerId: string;
    runActorId: string;
    audit: ApprovalAudit;
    recordDecision: (
      requestId: string,
      record: PendingApprovalRecord,
      approved: boolean,
      call?: ApprovedToolCall,
    ) => Promise<boolean>;
    grantOnce: (approvalKey: string) => void;
  },
): Promise<SteeredApproval> {
  const decision = request.approval;
  if (!decision) return { kind: "ignored" };
  const verdict = decision.approved ? "approve" : "deny";
  const record = await ctx.pending.get(decision.requestId);
  const refusal =
    approvalRefusal(record, ctx.sessionId, ctx.clickerId) ??
    (!samePerson(ctx.clickerId, ctx.runActorId) ? "not_requester" : undefined) ??
    (!record?.call || (decision.approved && (decision.scope ?? "once") !== "once") ? "not_executable" : undefined);
  if (refusal || !record?.call) {
    ctx.audit({
      action: `command_approval.${verdict}`,
      resource: decision.requestId,
      status: "refused",
      detail: JSON.stringify({ approvalOutcome: refusal, delivery: "live_run" }),
    });
    return { kind: "ignored" };
  }
  const call = decision.approved ? approvedToolCall(decision.requestId, record) : undefined;
  if (!(await ctx.recordDecision(decision.requestId, record, decision.approved, call))) {
    ctx.audit({
      action: `command_approval.${verdict}`,
      resource: decision.requestId,
      status: "refused",
      detail: JSON.stringify({ approvalOutcome: "already_decided", delivery: "live_run" }),
    });
    return { kind: "ignored" };
  }
  const approver = request.actor.displayName?.trim() || "The requesting human";
  const summary = record.summary ?? record.command;
  if (!decision.approved) {
    ctx.audit({
      action: "command_approval.deny",
      resource: record.command,
      status: "refused",
      detail: JSON.stringify({ approvalOutcome: "denied", delivery: "live_run" }),
    });
    return { kind: "denied", summary, approver };
  }
  ctx.grantOnce(record.approvalKey ?? record.command);
  ctx.audit({
    action: "command_approval.once",
    resource: record.command,
    status: "ok",
    detail: JSON.stringify({ delivery: "live_run" }),
  });
  return { kind: "run", summary, approver, call: call! };
}

export async function withdrawCallApprovals(
  pending: DurableMap<PendingApprovalRecord>,
  sessionId: string,
  actorId: string,
  card: string,
  audit: ApprovalAudit,
): Promise<{ withdrawn: string[] }> {
  const cardId = card.trim().toLowerCase();
  const rows = await pending.selectEntries({ where: { field: "sessionId", anyOfFold: [sessionId] } });
  const withdrawn: string[] = [];
  for (const [requestId, record] of rows) {
    if (approvalRefusal(record, sessionId, actorId) || !record.call) continue;
    if (approvalCardId(record.approvalKey ?? "") !== cardId) continue;
    await pending.delete(requestId);
    withdrawn.push(record.summary ?? record.command);
    audit({
      action: "command_approval.withdraw",
      resource: record.command,
      status: "ok",
      detail: JSON.stringify({ requestId }),
    });
  }
  return { withdrawn };
}

export interface EarlierApprovals {
  decided: Set<string>;
  unstarted: Array<{ call: ApprovedToolCall; approvalKey: string }>;
}

export function approvedRequestsStarted(items: readonly Item[]): Set<string> {
  return new Set(
    items.flatMap((item) =>
      item.kind === "ToolCall" && typeof item.body.approvedRequestId === "string" ? [item.body.approvedRequestId] : [],
    ),
  );
}

export function approvedCallsOnEarlierAttempt(items: readonly Item[], actorId: string): EarlierApprovals {
  const started = approvedRequestsStarted(items);
  const earlier: EarlierApprovals = { decided: new Set(), unstarted: [] };
  for (const item of items) {
    if (item.kind !== "ElicitationResponse" || item.approved !== true) continue;
    if (!samePerson(item.author ?? undefined, actorId)) continue;
    const call = item.body.call as ApprovedToolCall | undefined;
    const approvalKey = item.body.approvalKey;
    if (!call || call.requestId !== item.elicitId || typeof approvalKey !== "string") continue;
    if (earlier.decided.has(call.requestId)) continue;
    earlier.decided.add(call.requestId);
    if (!started.has(call.requestId)) earlier.unstarted.push({ call, approvalKey });
  }
  return earlier;
}
