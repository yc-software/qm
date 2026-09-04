import { test } from "node:test";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { exerciseDeliveryStore } from "./delivery-store-contract.ts";

test("memory delivery store: idempotent enqueue, pending-by-type, ack, get", async () => {
  await exerciseDeliveryStore(createDeliveryStore());
});
