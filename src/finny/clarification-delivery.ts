import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { Delivery, Destination } from "../types.ts";
import type { CreateFinnyClarificationRequestInput, FinnyStore } from "./store.ts";
import type { FinnyClarificationRequest } from "./types.ts";

export async function createAndDeliverFinnyClarification(input: {
  store: FinnyStore;
  deliveries: DeliveryStore;
  destination: Destination;
  request: CreateFinnyClarificationRequestInput;
}): Promise<{ request: FinnyClarificationRequest; delivery: Delivery }> {
  const request = await input.store.createClarificationRequest(input.request);
  const [surface, channel, ...threadParts] = request.originThreadRef.split(":");
  const threadTs = threadParts.join(":");
  if (
    surface !== "slack" ||
    !channel ||
    !threadTs ||
    input.destination.type !== "slack" ||
    input.destination.target !== `${channel}:${threadTs}` ||
    (input.destination.threadTs !== undefined && input.destination.threadTs !== threadTs)
  )
    throw new Error("Finny clarification delivery destination does not match its origin thread");
  const delivery = await input.deliveries.enqueue({
    destination: { ...input.destination, finnyPlanRequestId: request.requestId },
    text: request.question,
    idempotencyKey: `finny-clarification:${request.idempotencyKey}`,
  });
  return { request, delivery };
}
