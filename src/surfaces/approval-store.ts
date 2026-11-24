import { swallowAs } from "../util/errors.ts";
import { isSystemActor, type Destination, type PendingApprovalRecord, type TurnRequest } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { approvalDeliveryKey } from "./approval-cards.ts";

export type ApprovalCardRoute = (request: TurnRequest) => Destination | undefined;

export function triggerApprovalCardRoute(
  slackRoute: ApprovalCardRoute,
  genericChatRoute: ApprovalCardRoute,
  genericChatType: string,
): ApprovalCardRoute {
  return (request) => {
    const generic = genericChatRoute(request);
    if (generic) return generic;
    if (
      request.origin?.kind === "automation" &&
      request.origin.destination?.type === genericChatType &&
      !isSystemActor(request.actor.externalId)
    )
      return request.origin.destination;
    const threadRef = request.conversation?.threadRef ?? "";
    if (threadRef.startsWith("web:") || threadRef.startsWith("swarm:")) return undefined;
    return slackRoute(request);
  };
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
  routes: Readonly<Record<string, ApprovalCardRoute>>,
) {
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    const destination = record.request && routes[record.request.surface]?.(record.request);
    if (!destination) return;
    await deliveries.enqueue({
      destination: { ...destination, commandApprovalId: id },
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
      await claimThenBind(backing.claimTenants, async () => {
        for (const [id, record] of await backing.entries()) await deliver(id, record);
      });
    },
  };
}
