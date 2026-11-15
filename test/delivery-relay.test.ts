import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryRelay } from "../src/delivery/relay.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("a delivery its receiver keeps refusing is retried with growing gaps and delivered once the receiver recovers", async (t) => {
  t.mock.method(console, "error", () => {});
  const store = createDeliveryStore();
  const attempts: number[] = [];
  const send = async () => (attempts.push(Date.now()) < 6 ? Promise.reject(new Error("HTTP 401")) : undefined);
  const relay = createDeliveryRelay(store, { type: "slack", claimMs: 40, send });
  t.after(() => relay.stop());
  const d = await store.enqueue({ destination: { type: "slack", target: "t" }, text: "x", idempotencyKey: "k" });
  relay.start();
  await until(async () => (await store.get(d.id))?.deliveredAt !== null, 5_000);
  const gaps = attempts.slice(1).map((at, i) => at - attempts[i]!);
  assert.ok(gaps.at(-1)! >= 4 * gaps[0]!, `gaps grow: ${gaps.join(", ")}ms`);
});
