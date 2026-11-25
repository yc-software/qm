import { swallowAs } from "../util/errors.ts";
import { isSystemActor, type Destination, type PendingApprovalRecord, type TurnRequest } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { principalDestination } from "../reach/reach.ts";
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
  async function routed(record: PendingApprovalRecord): Promise<Destination | undefined> {
    const req = record.request;
    if (!req || req.surface === "web") return undefined;
    const route = routes[req.surface] ?? (req.origin?.kind === "automation" ? automationRoute : undefined);
    return await route?.(req, record.sessionId);
  }
  async function withCardHome(record: PendingApprovalRecord): Promise<PendingApprovalRecord> {
    const owner = record.request?.actor.externalId;
    if (!record.request || !owner || isSystemActor(owner) || record.request.surface === "web") return record;
    if (await routed(record)) return record;
    return { ...record, cardTo: owner };
  }
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    const destination =
      (await routed(record)) ??
      (record.cardTo ? { ...principalDestination(record.cardTo, record.cardTo), webHome: true } : undefined);
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
      const homed = await withCardHome(record).catch(swallowAs("approvals: home card", record));
      await backing.put(id, homed);
      await deliver(id, homed).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async deliverPending(): Promise<void> {
      await claimThenBind(backing.claimTenants, async () => {
        for (const [id, record] of await backing.entries()) await deliver(id, record);
      });
    },
  };
}
