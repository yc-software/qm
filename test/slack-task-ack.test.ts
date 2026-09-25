import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createTaskAcknowledgements, type TaskAckState } from "../src/slack/task-ack.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

function setup() {
  const store = createMemoryMap<TaskAckState>();
  const events: string[] = [];
  const client = {
    reactions: {
      add: async ({ timestamp, name }: { timestamp: string; name: string }) => {
        events.push(`add:${timestamp}:${name}`);
      },
      remove: async ({ timestamp, name }: { timestamp: string; name: string }) => {
        events.push(`remove:${timestamp}:${name}`);
      },
    },
  };
  const manager = createTaskAcknowledgements(store, createNoopLeaderLease());
  return { store, events, client, manager };
}

test("one emoji moves between user messages and survives manager restart", async () => {
  const { store, events, client, manager } = setup();
  let picks = 0;
  const pick = async () => {
    picks++;
    return "pirate_flag";
  };
  await manager.move(client, "r1", "D1", "10.1", pick);
  await manager.move(client, "r1", "D1", "10.2");
  const restarted = createTaskAcknowledgements(store, createNoopLeaderLease());
  await restarted.move(client, "r1", "D1", "10.3", pick);
  assert.equal(picks, 1);
  assert.deepEqual(events.slice(-2), ["add:10.3:pirate_flag", "remove:10.2:pirate_flag"]);
  await restarted.finish(client, "r1");
  assert.equal(events.at(-1), "remove:10.3:pirate_flag");
  const count = events.length;
  await manager.move(client, "r1", "D1", "10.4", pick);
  assert.equal(events.length, count);
});

test("late user-message handling cannot move an acknowledgement backwards or clear another task", async () => {
  const { events, client, manager, store } = setup();
  await manager.move(client, "r1", "D1", "10.1", async () => "pirate_flag");
  await manager.move(client, "r2", "D1", "10.2", async () => "memo");
  await manager.move(client, "r1", "D1", "10.4");
  await manager.move(client, "r1", "D1", "10.3");
  assert.equal((await store.get("r1"))?.target, "10.4");
  await manager.finish(client, "r1");
  assert.equal((await store.get("r2"))?.finished, false);
  assert.ok(!events.includes("remove:10.2:memo"));
});

test("completion racing initial acknowledgement cannot leave a stuck reaction", async () => {
  const { client, manager, store, events } = setup();
  await Promise.all([manager.move(client, "r1", "D1", "10.1", async () => "memo"), manager.finish(client, "r1")]);
  assert.equal((await store.get("r1"))?.finished, true);
  assert.equal(events.at(-1), "remove:10.1:memo");
});

test("failed old-reaction removal is durable and retried after restart", async () => {
  const { client, manager, store, events } = setup();
  await manager.move(client, "r1", "D1", "10.1", async () => "memo");
  const remove = client.reactions.remove;
  client.reactions.remove = async () => {
    throw new Error("temporary Slack failure");
  };
  await assert.rejects(manager.move(client, "r1", "D1", "10.2"));
  assert.deepEqual((await store.get("r1"))?.previous, ["10.1"]);
  client.reactions.remove = remove;
  await createTaskAcknowledgements(store, createNoopLeaderLease()).finish(client, "r1");
  assert.ok(events.includes("remove:10.1:memo"));
  assert.ok(events.includes("remove:10.2:memo"));
});

test("a lost lease and delayed Slack add cannot resurrect a completed reaction", async () => {
  const { store } = setup();
  let lose!: () => void;
  let added!: () => void;
  let release!: () => void;
  const started = new Promise<void>((r) => {
    added = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const lost = new Promise<void>((r) => {
    lose = r;
  });
  const reactions = new Set<string>();
  const client = {
    reactions: {
      add: async ({ timestamp }: { timestamp: string }) => {
        added();
        await blocked;
        reactions.add(timestamp);
      },
      remove: async ({ timestamp }: { timestamp: string }) => {
        reactions.delete(timestamp);
      },
    },
  };
  let holds = 0;
  const first = createTaskAcknowledgements(store, {
    hold: async (_key, fn) => fn(holds++ === 0 ? lost : new Promise<void>(() => {})),
  });
  const pending = first.move(client, "r1", "D1", "10.1");
  await started;
  lose();
  await createTaskAcknowledgements(store, createNoopLeaderLease()).finish(client, "r1");
  release();
  await pending;
  assert.equal((await store.get("r1"))?.finished, true);
  assert.equal(reactions.size, 0);
});

test("reconciliation retries a persisted move without another incoming message", async () => {
  const { client, manager, store, events } = setup();
  await manager.move(client, "r1", "D1", "10.1", async () => "memo");
  const add = client.reactions.add;
  client.reactions.add = async () => {
    throw new Error("rate limited");
  };
  await assert.rejects(manager.move(client, "r1", "D1", "10.2"));
  client.reactions.add = add;
  await createTaskAcknowledgements(store, createNoopLeaderLease()).reconcile(client);
  assert.deepEqual(events.slice(-2), ["add:10.2:memo", "remove:10.1:memo"]);
  assert.equal((await store.get("r1"))?.synced, true);
  const count = events.length;
  await manager.reconcile(client);
  assert.equal(events.length, count);
});

for (const outbound of ["run", "post", "ack", "silent"] as const) {
  test(`restart clears completed task acknowledgement only after delivery, outbound=${outbound}`, async () => {
    const { client, manager, store, events } = setup();
    const { runs } = createMemoryRunStore();
    const deliveries = createDeliveryStore();
    const actor = { id: "person", type: "internal" as const };
    const { run } = await runs.enqueue({
      sessionId: "task-session",
      request: {
        actor,
        conversation: { kind: "dm", threadRef: "dm:D1", audience: [actor] },
        origin: { kind: "human" },
        surface: "slack",
        surfaceTools: outbound !== "run",
        deliveryTarget: "D1",
        text: "Do the task",
      } as OrchestratorInput,
    });
    await manager.move(client, run.id, "D1", "10.1");
    const restarted = createTaskAcknowledgements(store, createNoopLeaderLease(), { runs, deliveries });
    await restarted.reconcile(client);
    assert.equal((await store.get(run.id))?.finished, false);
    const claimed = await runs.claimById(run.id, "test", 10000);
    assert.ok(claimed);
    const finalDelivery =
      outbound === "silent"
        ? undefined
        : await deliveries.enqueue({
            destination: { type: "slack", target: "D1" },
            text: "Done",
            idempotencyKey: outbound === "post" ? `post:${run.id}:slack:D1:0` : `${outbound}:${run.id}`,
          });
    await runs.complete(
      run.id,
      claimed.leaseToken!,
      outbound === "silent" ? { status: "silent" } : { status: "ok", reply: "Done" },
    );
    if (finalDelivery) {
      await restarted.reconcile(client);
      assert.equal((await store.get(run.id))?.finished, false);
      assert.ok(!events.some((event) => event.startsWith("remove:")));
      if (outbound === "run") await restarted.finish(client, run.id);
      await deliveries.ack(finalDelivery.id, Date.now());
    }
    await restarted.reconcile(client);
    assert.equal((await store.get(run.id))?.finished, true);
    assert.equal(events.at(-1), "remove:10.1:eyes");
  });
}
