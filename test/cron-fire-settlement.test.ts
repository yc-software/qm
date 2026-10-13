import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryCronFireStore, createPostgresCronFireStore, type CronFireStore } from "../src/cron/fire-store.ts";
import { settleCronFire, withCronFireSettlement } from "../src/cron/fire-settlement.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { scopeId, type Delivery } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const CRON = "cron-settle";
const fire = (fireKey: string) => ({
  fireKey,
  threadRef: `cron:${CRON}:fire:${fireKey.padEnd(12, "0")}`,
  provenance: {
    trigger: "cron" as const,
    surface: "slack",
    fireKey,
    sourceScopeId: scopeId("personal", "U1"),
    sourceThreadRef: `cron:${CRON}:fire:${fireKey.padEnd(12, "0")}`,
  },
});
const fireStores: Array<[string, () => CronFireStore]> = [
  ["memory", createMemoryCronFireStore],
  ["postgres", () => createPostgresCronFireStore(URL!)],
];

for (const [name, createFires] of fireStores) {
  const skip = name === "postgres" && !URL ? "set DATABASE_URL to run the Postgres variant" : false;

  test(
    `${name}: an ack that lands before the scheduler writes delivering still settles the fire ok`,
    { skip },
    async () => {
      const fires = createFires();
      const { fireKey, threadRef, provenance } = fire("ack-first");
      const deliveries = withCronFireSettlement(createDeliveryStore(), fires);
      await fires.record(CRON, { fireKey, threadRef, firedAt: 1_000, status: "running" });
      const delivery = await deliveries.enqueue({
        destination: { type: "slack", target: "C1" },
        text: "Daily numbers",
        provenance,
        idempotencyKey: `${fireKey}-${name}`,
      });
      await deliveries.ack(delivery.id, 2_000);
      await fires.record(CRON, {
        fireKey,
        threadRef,
        firedAt: 1_000,
        status: "delivering",
        reply: "Daily numbers",
        sessionId: "s1",
      });
      const settled = await fires.latestForThread(CRON, threadRef);
      assert.equal(settled?.status, "ok");
      assert.equal(settled?.endedAt, 2_000);
      assert.equal(settled?.reply, "Daily numbers");
      assert.equal(settled?.sessionId, "s1");
    },
  );

  test(`${name}: a delivery that expires undelivered fails its fire`, { skip }, async () => {
    const fires = createFires();
    const { fireKey, threadRef, provenance } = fire("expired");
    const expired: Delivery[] = [];
    const store = createDeliveryStore({ maxAgeMs: 10, onExpire: (d) => expired.push(d) });
    const deliveries = withCronFireSettlement(store, fires);
    await fires.record(CRON, { fireKey, threadRef, firedAt: 1_000, status: "delivering" });
    await deliveries.enqueue({
      destination: { type: "slack", target: "C1" },
      text: "Daily numbers",
      provenance,
      idempotencyKey: `${fireKey}-${name}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await deliveries.claimPending("slack", 1_000), []);
    assert.equal(expired.length, 1);
    await settleCronFire(fires, expired[0]!, "failed", 3_000, "delivery expired undelivered");
    const settled = await fires.latestForThread(CRON, threadRef);
    assert.equal(settled?.status, "failed");
    assert.equal(settled?.note, "delivery expired undelivered");
  });
}
