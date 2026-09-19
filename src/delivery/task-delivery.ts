import type { PoolClient } from "../persistence/pg-pool.ts";
import type { Delivery } from "../types.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import { DurableTaskDeferred } from "../durable/tasks.ts";

export interface DeliveryTaskContext {
  step<T>(name: string, execute: () => Promise<T>): Promise<T>;
}

export interface DeliveryTaskScheduler {
  spawnDelivery(id: string, transaction?: PoolClient): Promise<void>;
}

export type DeliveryHandler = (delivery: Delivery, context: DeliveryTaskContext) => Promise<void>;

export interface DeliveryDispatcher {
  register(types: readonly string[], handler: DeliveryHandler, account?: string): () => void;
  execute(id: string, context: DeliveryTaskContext): Promise<void>;
}

export function createDeliveryDispatcher(store: DeliveryStore): DeliveryDispatcher {
  const handlers = new Map<string, DeliveryHandler>();
  return {
    register(types, handler, account = "default") {
      const keys = types.map((type) => `${type}:${account}`);
      for (const key of keys) if (handlers.has(key)) throw new Error(`Delivery handler already registered for ${key}`);
      for (const key of keys) handlers.set(key, handler);
      return () => {
        for (const key of keys) if (handlers.get(key) === handler) handlers.delete(key);
      };
    },
    async execute(id, context) {
      const delivery = await store.get(id);
      if (!delivery || delivery.deliveredAt !== null || delivery.shadow) return;
      const handler = handlers.get(`${delivery.destination.type}:${delivery.destination.slackAccount ?? "default"}`);
      if (!handler) throw new DurableTaskDeferred();
      await handler(delivery, context);
      await context.step("delivery:acknowledge", async () => {
        await store.ack(delivery.id, Date.now());
        return true;
      });
    },
  };
}
