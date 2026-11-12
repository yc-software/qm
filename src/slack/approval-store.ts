import { swallowAs } from "../util/errors.ts";
import { APPROVAL_LIFETIME_MS, type PendingApprovalRecord, type ScopeId } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { approvalDeliveryRecipient } from "./approval-cards.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { Tenant } from "../tenants/context.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
) {
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    if (record.request?.surface !== "slack") return;
    const actorId = record.request.actor.externalId;
    const recipient = approvalDeliveryRecipient(record.request);
    if (!actorId || !recipient) return;
    const origin = record.request.surfaceOrigin;
    const threadTs = record.request.conversation?.kind === "dm" ? origin?.replyThread : undefined;
    await deliveries.enqueue({
      destination: {
        ...principalDestination(actorId, actorId),
        target: recipient,
        commandApprovalId: id,
        ...(threadTs ? { threadTs } : {}),
        ...(origin ? { account: { id: origin.author.account, workspace: origin.workspace } } : {}),
      },
      text: `Approval needed: ${record.summary ?? record.command}`,
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }
  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      await deliver(id, record).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async expireStale(audit: Pick<AuditLog, "record">, tenant: Tenant, scopeLabel: ScopeId): Promise<void> {
      for (const [id, record] of await backing.deleteBefore("createdAt", Date.now() - APPROVAL_LIFETIME_MS))
        audit.record(tenant, {
          at: Date.now(),
          principalId: "system",
          action: "command_approval.expire",
          resource: id,
          scopeLabel,
          status: "ok",
          detail: JSON.stringify({
            lifetimeMs: APPROVAL_LIFETIME_MS,
            kind: record.kind ?? "approval",
            command: record.summary ?? record.command,
            sessionId: record.sessionId,
            requester: record.request?.actor.externalId,
          }),
        });
    },
    async deliverPending(): Promise<void> {
      await claimThenBind(backing.claimTenants, async () => {
        for (const [id, record] of await backing.entries()) await deliver(id, record);
      });
    },
  };
}
