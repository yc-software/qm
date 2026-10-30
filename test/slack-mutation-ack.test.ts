import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { createThreadTracker } from "../src/slack/message-gating.ts";

async function mutationHarness(action: "delete" | "pin" | "unpin" | "react", error?: string) {
  const store = createDeliveryStore();
  const operation = action === "unpin" ? "pin" : action;
  const delivery = await store.enqueue({
    destination: {
      type: "slack",
      target: "C-mutation:100.1",
      [operation]: {
        messageTs: "100.2",
        ...(action === "react" ? { emoji: "eyes" } : {}),
        ...(action === "unpin" ? { remove: true } : {}),
      },
    },
    text: "",
    idempotencyKey: action,
  });
  const acknowledgments: string[] = [];
  let calls = 0;
  let rejection = error;
  const mutate = async () => {
    calls++;
    if (rejection) throw Object.assign(new Error(`remote rejection: ${rejection}`), { data: { error: rejection } });
    return { ok: true };
  };
  const client = { chat: { delete: mutate }, pins: { add: mutate, remove: mutate }, reactions: { add: mutate } };
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: (type: string, ms: number) => store.claimPending(type, ms),
      ackDelivery: async (id: string) => {
        acknowledgments.push(id);
        await store.ack(id, Date.now());
      },
      holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
    } as never,
    flow: { inFlightRuns: { has: () => false, add() {}, delete() {} } } as never,
    threads: createThreadTracker(),
    clientForIdentity: () => client,
    claimMs: 1000,
  });
  return {
    store,
    delivery,
    acknowledgments,
    poll: () => poller.pollDeliveries(client),
    confirm: () => {
      rejection = undefined;
    },
    calls: () => calls,
  };
}

for (const [action, code] of [
  ["delete", "cant_delete_message"],
  ["pin", "restricted_action"],
  ["unpin", "missing_scope"],
  ["react", "invalid_auth"],
] as const) {
  test(`rejected ${action} remains pending until a confirmed retry`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const h = await mutationHarness(action, code);
    await h.poll();
    assert.deepEqual(h.acknowledgments, [], "a rejected remote mutation is not acknowledged");
    assert.equal((await h.store.pending("slack")).length, 1);
    h.confirm();
    t.mock.timers.setTime(Date.now() + 2000);
    await h.poll();
    assert.equal(h.calls(), 2, "the rejected mutation remains retryable");
    assert.deepEqual(h.acknowledgments, [h.delivery.id]);
    assert.equal((await h.store.pending("slack")).length, 0);
  });
  test(`confirmed ${action} is acknowledged`, async () => {
    const h = await mutationHarness(action);
    await h.poll();
    assert.deepEqual(h.acknowledgments, [h.delivery.id]);
  });
}

for (const [action, code] of [
  ["delete", "message_not_found"],
  ["pin", "already_pinned"],
  ["unpin", "no_pin"],
  ["unpin", "not_pinned"],
  ["react", "already_reacted"],
] as const) {
  test(`${action} ${code} already satisfies the requested state`, async () => {
    const h = await mutationHarness(action, code);
    await h.poll();
    assert.deepEqual(h.acknowledgments, [h.delivery.id]);
  });
}
