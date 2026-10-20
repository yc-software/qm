import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutbound, type OutboundPost, type QueuedPost } from "../src/surfaces/outbound.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const post = (key: string, type = "slack"): OutboundPost => ({
  destination: { type, target: "C1:1.0" },
  text: `hello ${key}`,
  idempotencyKey: key,
});

function rig() {
  const retries = createMemoryMap<QueuedPost>();
  const sent: string[] = [];
  const after: string[] = [];
  let failure: Error | null = null;
  const outbound = createOutbound({
    idempotency: createIdempotencyStore(createMemoryMap()),
    retries,
    afterSend: (p) => after.push(p.idempotencyKey),
  });
  outbound.register(["slack", "web"], async (p) => {
    if (failure) throw failure;
    sent.push(p.idempotencyKey);
  });
  return { outbound, retries, sent, after, fail: (e: Error | null) => (failure = e) };
}

test("a transient surface failure is queued, counted as sent once, and goes out when the surface recovers", async () => {
  const r = rig();
  r.fail(new Error("Slack is unreachable"));
  assert.deepEqual(await r.outbound.send(post("k1")), { queued: true });
  assert.deepEqual(await r.outbound.send(post("k1")), {}, "a repeat of the key is not queued twice");
  assert.equal((await r.retries.entries()).length, 1);
  r.fail(new Error("Slack is still unreachable"));
  assert.equal(await r.outbound.retryQueued(), 0);
  assert.equal((await r.retries.get("k1"))?.lastError, "Slack is still unreachable", "kept with its latest error");
  r.fail(null);
  assert.equal(await r.outbound.retryQueued(), 1);
  assert.deepEqual(r.sent, ["k1"]);
  assert.deepEqual(r.after, ["k1"], "recipient bookkeeping runs once the post really lands");
  assert.equal(await r.retries.get("k1"), null);
  assert.equal(await r.outbound.retryQueued(), 0);
});

test("a post for a surface that is not connected yet waits in the queue for it", async () => {
  const retries = createMemoryMap<QueuedPost>();
  const outbound = createOutbound({ retries });
  assert.deepEqual(await outbound.send(post("k6")), { queued: true });
  const sent: string[] = [];
  outbound.register(["slack"], async (p) => void sent.push(p.idempotencyKey));
  assert.equal(await outbound.retryQueued(), 1);
  assert.deepEqual(sent, ["k6"]);
  await assert.rejects(createOutbound({}).send(post("k7")), /no slack connection is available/);
});

test("permanent refusals and web transcript failures throw instead of queueing", async () => {
  const r = rig();
  r.fail(Object.assign(new Error("channel_not_found"), { permanent: true }));
  await assert.rejects(r.outbound.send(post("k2")), /channel_not_found/);
  r.fail(new Error("database unavailable"));
  await assert.rejects(r.outbound.send(post("k3", "web")), /database unavailable/);
  assert.equal((await r.retries.entries()).length, 0);
  r.fail(null);
  await r.outbound.send(post("k2"));
  assert.deepEqual(r.sent, ["k2"], "a refused key was not remembered, so a later send can still go out");
});

test("a queued post that turns permanent or ages out is dropped", async () => {
  const r = rig();
  r.fail(new Error("timeout"));
  await r.outbound.send(post("k4"));
  await r.outbound.send(post("k5"));
  r.fail(Object.assign(new Error("not_in_channel"), { permanent: true }));
  const k5 = (await r.retries.get("k5"))!;
  await r.retries.put("k5", { ...k5, firstFailedAt: k5.firstFailedAt - 7 * 60 * 60_000 });
  assert.equal(await r.outbound.retryQueued(), 0);
  assert.equal((await r.retries.entries()).length, 0);
  assert.deepEqual(r.sent, []);
});
