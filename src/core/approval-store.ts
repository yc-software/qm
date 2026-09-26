import { swallowAs } from "../util/errors.ts";
import type { PendingApprovalRecord } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function approvalDeliveryRecipient(actor: { externalId?: string } | undefined): string | undefined {
  const id = actor?.externalId;
  return id && !id.startsWith("system:") ? id : undefined;
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
) {
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    if (record.request?.surface !== "slack") return;
    const actorId = approvalDeliveryRecipient(record.request.actor);
    if (!actorId) return;
    await deliveries.enqueue({
      destination: {
        ...principalDestination(actorId, actorId),
        commandApprovalId: id,
        ...(record.request.slackSource
          ? { slackAccountId: record.request.slackSource.accountId, slackTeamId: record.request.slackSource.teamId }
          : {}),
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
    async deliverPending(): Promise<void> {
      for (const [id, record] of await backing.entries()) await deliver(id, record);
    },
  };
}
