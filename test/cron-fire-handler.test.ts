import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFireHandler, DIGEST_HEADING, type FireReport } from "../src/cron/handler/fire-handler.ts";
import { runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId, type Destination } from "../src/types.ts";
import { testMap } from "./support/test-database.ts";

const report = (cronId: string, text: string, extra: Partial<FireReport> = {}): FireReport => ({
  cronId,
  cronTitle: `Task ${cronId}`,
  at: 1,
  text,
  ...extra,
});

describe("cron fire handler", () => {
  it("drops a cron's unchanged repeat without asking the model", async () => {
    let calls = 0;
    const handler = createFireHandler({
      model: async () => {
        calls++;
        return '{"sendNow":[],"digestItems":["Task a: 3 new"],"dropped":[]}';
      },
    });
    await handler.handle([report("a", "3 new")], 1);
    const second = await handler.handle([report("a", "3 new")], 2);
    assert.equal(calls, 1);
    assert.deepEqual(
      second.dropped.map((d) => d.cronId),
      ["a"],
    );
  });

  it("sends urgent reports now without the model and falls back to sending everything when the model fails", async () => {
    const handler = createFireHandler({ model: async () => "not json" });
    const decision = await handler.handle([report("a", "disk full", { urgent: true }), report("b", "done")], 1);
    assert.deepEqual(decision.sendNow, ["Task a: disk full", "Task b: done"]);
  });

  it("accumulates digest items until flushed", async () => {
    const handler = createFireHandler({
      model: async () => '{"sendNow":[],"digestItems":["x"],"dropped":[]}',
    });
    await handler.handle([report("a", "1")], 1);
    await handler.handle([report("b", "2")], 2);
    assert.equal(await handler.flushDigest(3), `${DIGEST_HEADING}\n- x\n- x`);
    assert.equal(await handler.flushDigest(4), null);
  });
});

describe("runTrigger: cron replies to the owner's own DM are held", () => {
  const deps = (): TriggerDeps => ({
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(testMap()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run: async () => ({ status: "ok", reply: "[urgent] build broke" }),
  });
  const fire = (d: TriggerDeps, destination: Destination, fireKey: string) =>
    runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      input: "check",
      fireKey,
      surface: "cron",
      cronId: "c1",
      destination,
    });

  it("holds the owner's DM delivery and strips the urgent marker", async () => {
    const d = deps();
    await fire(d, { type: "principal", target: "U1", onBehalfOf: "U1" }, "cron:c1:1");
    assert.deepEqual(await d.deliveries.pending("principal"), []);
    const [held] = await d.deliveries.listHeld();
    assert.equal(held?.text, "build broke");
    assert.equal(held?.sourceCronId, "c1");
    assert.ok(held!.hold!.until <= held!.createdAt);
  });

  it("leaves deliveries to other people untouched", async () => {
    const d = deps();
    await fire(d, { type: "principal", target: "U2", onBehalfOf: "U1" }, "cron:c1:2");
    assert.equal((await d.deliveries.pending("principal")).length, 1);
    assert.deepEqual(await d.deliveries.listHeld(), []);
  });
});
