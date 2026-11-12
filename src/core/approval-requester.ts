import type { DurableMap } from "../persistence/durable-map.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import type { Tenant } from "../tenants/context.ts";
import { APPROVAL_LIFETIME_MS, type PendingApprovalRecord, type ScopeId, type TurnResult } from "../types.ts";

export const BOT_REQUESTER_APPROVAL_NOTE =
  "This request came from a bot or app, not a person. Only the person who asked can approve a step that needs approval, so no approval was requested and the step did not run. Continue without it, and tell the thread that a person has to ask for this step themselves.";

export const BOT_REQUESTER_REFUSAL =
  "This request came from a bot or app, and the next step needs a person's approval. A person has to ask for it directly.";

export function botApprovalRefusal(
  audit: (event: Omit<AuditEvent, "at" | "principalId" | "scopeLabel">) => void,
  sessionId: string,
  command: string,
  reason: string,
): TurnResult {
  audit({
    action: "command_approval.unavailable",
    resource: command,
    status: "refused",
    detail: JSON.stringify({ approvalOutcome: "requester_is_bot", reason }),
  });
  return { status: "refused", sessionId, reason: BOT_REQUESTER_REFUSAL, refusalKind: "approval_denied" };
}

export const undeliverableApprovalNote = (failure: string): string =>
  `The approval request for this step could not be delivered to the person who asked (${failure}), so it was declined and the step did not run. Continue without it, and tell the thread that a person has to ask for this step themselves.`;

export const UNREACHABLE_APPROVAL_DECIDER = "system:approval-unreachable";

export const APPROVAL_EXPIRED_DECIDER = "system:approval-expired";

export const expiredApprovalNote = (): string =>
  `Nobody answered the approval card for this step within ${APPROVAL_LIFETIME_MS / 60_000} minutes, so it expired and the step did not run. If it's still wanted, try the step again to raise a new card.`;

const stepOf = (record: PendingApprovalRecord): string =>
  record.screenedOutput ? record.command : (record.summary ?? record.command);

async function recordDeclined(
  sessions: Pick<SessionStore, "append">,
  requestId: string,
  record: PendingApprovalRecord,
  author: string,
  body: Record<string, unknown>,
  note: string,
): Promise<void> {
  const writer = { sessionId: record.sessionId };
  await sessions.append(writer, {
    kind: "ElicitationResponse",
    elicitId: requestId,
    approved: false,
    author,
    body: { command: record.command, ...body },
  });
  if (record.kind === "input") return;
  await sessions.append(writer, {
    kind: "UserMessage",
    hidden: true,
    text: `${note}\nThe step: ${stepOf(record)}`,
  });
}

export async function declineUnreachableApproval(
  deps: { approvals: DurableMap<PendingApprovalRecord>; sessions: Pick<SessionStore, "append"> },
  requestId: string,
  failure: string,
): Promise<PendingApprovalRecord | null> {
  const record = await deps.approvals.take(requestId);
  if (!record) return null;
  await recordDeclined(
    deps.sessions,
    requestId,
    record,
    UNREACHABLE_APPROVAL_DECIDER,
    { declined: "requester_unreachable", failure },
    undeliverableApprovalNote(failure),
  );
  return record;
}

export async function expireStaleApprovals(
  deps: {
    approvals: DurableMap<PendingApprovalRecord>;
    sessions: Pick<SessionStore, "append">;
    audit: Pick<AuditLog, "record">;
  },
  tenant: Tenant,
  scopeLabel: ScopeId,
): Promise<void> {
  const cutoff = Date.now() - APPROVAL_LIFETIME_MS;
  for (const [id, record] of await deps.approvals.entries()) {
    if (record.createdAt === undefined || record.createdAt >= cutoff) continue;
    await recordDeclined(
      deps.sessions,
      id,
      record,
      APPROVAL_EXPIRED_DECIDER,
      { declined: "expired" },
      expiredApprovalNote(),
    );
    deps.audit.record(tenant, {
      at: Date.now(),
      principalId: "system",
      action: "command_approval.expire",
      resource: id,
      scopeLabel,
      status: "ok",
      detail: JSON.stringify({
        lifetimeMs: APPROVAL_LIFETIME_MS,
        kind: record.kind ?? "approval",
        command: stepOf(record),
        sessionId: record.sessionId,
        requester: record.request?.actor.externalId,
      }),
    });
    await deps.approvals.deleteIf(id, (current) => current.createdAt === record.createdAt);
  }
}
