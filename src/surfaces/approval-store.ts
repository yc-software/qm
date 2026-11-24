import { swallowAs } from "../util/errors.ts";
import type { Destination, PendingApprovalRecord, TurnRequest } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { approvalDeliveryKey } from "./approval-cards.ts";

export type ApprovalCardRoute = (
  request: TurnRequest,
  sessionId: string,
) => Destination | undefined | Promise<Destination | undefined>;

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
  routes: Readonly<Record<string, ApprovalCardRoute>>,
  automationRoute?: ApprovalCardRoute,
) {
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    const req = record.request;
    if (!req) return;
    const route = routes[req.surface] ?? (req.origin?.kind === "automation" ? automationRoute : undefined);
    const destination = await route?.(req, record.sessionId);
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
