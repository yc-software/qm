import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue } from "../../reach/reach.ts";
import type { DeliveryProvenance, Destination } from "../../types.ts";
import { stripAckPrefix, type TurnPostKeys } from "./turn-helpers.ts";

export interface InterimReplyContext {
  surfaceName: string;
  spineTurn: boolean;
  addressed: boolean;
  strictReadOnly: boolean;
  destination: Destination | undefined;
  deliveries: DeliveryStore | undefined;
  postKeys: TurnPostKeys;
  provenance: (key: string) => DeliveryProvenance;
  ackText: () => string | undefined;
  postedSoFar: () => number;
}

export function interimReplyDelivery(ctx: InterimReplyContext): (text: string) => Promise<boolean> {
  return async (text) => {
    if (ctx.surfaceName === "web") return true;
    if (ctx.strictReadOnly || !ctx.destination || !ctx.deliveries) return false;
    if (ctx.spineTurn && (!ctx.addressed || ctx.postedSoFar() > 0)) return false;
    const interim = stripAckPrefix(text, ctx.ackText()).trim();
    if (!interim) return false;
    const key = `${ctx.postKeys.key(ctx.destination, 0)}:interim`;
    await reachEnqueue({
      deliveries: ctx.deliveries,
      destination: ctx.destination,
      text: interim,
      idempotencyKey: key,
      provenance: ctx.provenance(key),
    });
    return true;
  };
}

export function turnGuidance(
  soul: string | undefined,
  channelOrders: (() => Promise<string | undefined>) | undefined,
): () => Promise<string> {
  return async () => {
    const orders = (await channelOrders?.()) ?? "";
    return [soul ?? "", orders].filter((text) => text.trim()).join("\n\n");
  };
}
