import { test } from "node:test";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import {
  exerciseDeliveryExpiry,
  exerciseDeliveryExpiryRevive,
  exerciseDeliveryStore,
} from "./delivery-store-contract.ts";

test("memory delivery store: idempotent enqueue, pending-by-type, ack, get", async () => {
  await exerciseDeliveryStore(createDeliveryStore());
});

test("memory delivery store: undelivered rows expire after the TTL instead of clogging the queue", async () => {
  await exerciseDeliveryExpiry((opts) => createDeliveryStore(opts));
});

test("memory delivery store: once-ever keys revive after a TTL drop instead of deadlocking", async () => {
  await exerciseDeliveryExpiryRevive((opts) => createDeliveryStore(opts));
});
