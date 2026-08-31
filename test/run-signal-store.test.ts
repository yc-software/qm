import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunSignalStore, startSignalPoll } from "../src/runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import {
  createPostgresTransactionalOutbox,
  createTransactionalOutboxEntry,
} from "../src/persistence/transactional-outbox.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the pg run-signal tests";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
};

test("memory store: send appends, takePending drains in order and consumes", async () => {
  const store = createMemoryRunSignalStore();
  await store.send("r1", { kind: "steer", text: "a" });
  await store.send("r1", { kind: "abort" });
  await store.send("other", { kind: "abort" });
  const taken = await store.takePending("r1");
  assert.deepEqual(
    taken.map((s) => s.kind),
    ["steer", "abort"],
  );
  assert.deepEqual(await store.takePending("r1"), [], "consumed — second take is empty");
  assert.equal((await store.takePending("other")).length, 1, "other run unaffected");
});

test("memory store: onSignal doorbell fires on send for that run only; unsubscribe stops it", async () => {
  const store = createMemoryRunSignalStore();
  let rings = 0;
  const off = store.onSignal("r1", () => rings++);
  await store.send("other", { kind: "abort" });
  assert.equal(rings, 0, "other run's send does not ring");
  await store.send("r1", { kind: "steer", text: "x" });
  assert.equal(rings, 1);
  off();
  await store.send("r1", { kind: "steer", text: "y" });
  assert.equal(rings, 1, "no ring after unsubscribe");
});

test("startSignalPoll: doorbell dispatches a signal immediately, far before the poll interval", async () => {
  const store = createMemoryRunSignalStore();
  const steered: string[] = [];
  const stop = startSignalPoll(
    store,
    "r1",
    {
      onSteer: async (text) => {
        steered.push(text);
      },
      onAbort: async () => {},
    },
    { intervalMs: 60_000 },
  );
  try {
    await store.send("r1", { kind: "steer", text: "now" });
    await until(() => steered.length === 1, 500);
    assert.deepEqual(steered, ["now"]);
  } finally {
    stop();
  }
});

test("startSignalPoll: a steer's ts is dispatched to onSteer (so the harness can persist + dedupe it)", async () => {
  const store = createMemoryRunSignalStore();
  const seen: Array<{ text: string; ts?: string }> = [];
  const stop = startSignalPoll(
    store,
    "r1",
    {
      onSteer: async (text, ts) => {
        seen.push({ text, ...(ts ? { ts } : {}) });
      },
      onAbort: async () => {},
    },
    { intervalMs: 60_000 },
  );
  try {
    await store.send("r1", { kind: "steer", text: "send it", ts: "900.001" });
    await until(() => seen.length === 1, 500);
    assert.deepEqual(seen, [{ text: "send it", ts: "900.001" }]);
  } finally {
    stop();
  }
});

test("startSignalPoll: a legacy durable followUp row is dispatched as a steer during rolling deploys", async () => {
  const store = createMemoryRunSignalStore();
  const seen: string[] = [];
  const stop = startSignalPoll(
    store,
    "r1",
    {
      onSteer: async (text) => {
        seen.push(text);
      },
      onAbort: async () => {},
    },
    { intervalMs: 60_000 },
  );
  try {
    await store.send("r1", { kind: "followUp", text: "legacy text" } as never);
    await until(() => seen.length === 1, 500);
    assert.deepEqual(seen, ["legacy text"]);
  } finally {
    await stop();
  }
});

test("startSignalPoll: discard mode drains pending and live signals without invoking handlers", async () => {
  const store = createMemoryRunSignalStore();
  const handled: string[] = [];
  const request = {
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "signed-run" },
    text: "provider write",
    ownerKeychainUnion: true,
    unattendedGrants: ["admin.sessions.read"],
  };
  await store.send("signed-run", { kind: "steer", text: "pending requestless" });
  await store.send("signed-run", { kind: "steer", text: "pending request-bearing", request });
  await store.send("signed-run", { kind: "abort" });
  const stop = startSignalPoll(
    store,
    "signed-run",
    {
      onSteer: async (text) => {
        handled.push(text);
      },
      onAbort: async () => {
        handled.push("abort");
      },
    },
    { intervalMs: 60_000, discard: true },
  );
  await until(async () => !(await store.pendingRunIds()).includes("signed-run"));
  await store.send("signed-run", { kind: "steer", text: "live request-bearing", request });
  await until(async () => (await store.pendingRunIds()).length === 0);
  await stop();
  assert.deepEqual(handled, []);
  assert.deepEqual(await store.takePending("signed-run"), []);
});

test("startSignalPoll: a doorbell during a slow drain queues one re-drain (no signal stranded)", async () => {
  const store = createMemoryRunSignalStore();
  const seen: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => (releaseFirst = r));
  const stop = startSignalPoll(
    store,
    "r1",
    {
      onSteer: async (text) => {
        seen.push(text);
        if (seen.length === 1) await firstGate;
      },
      onAbort: async () => {},
    },
    { intervalMs: 60_000 },
  );
  try {
    await store.send("r1", { kind: "steer", text: "first" });
    await until(() => seen.length === 1);
    await store.send("r1", { kind: "steer", text: "second" });
    releaseFirst();
    await until(() => seen.length === 2);
    assert.deepEqual(seen, ["first", "second"]);
  } finally {
    stop();
  }
});

test("startSignalPoll: stop consumes nothing more — an undrained signal stays pending for the terminal drain", async () => {
  const store = createMemoryRunSignalStore();
  const seen: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const stop = startSignalPoll(
    store,
    "r1",
    {
      onSteer: async (text) => {
        seen.push(text);
        if (text === "first") await firstGate;
      },
      onAbort: async () => {},
    },
    { intervalMs: 60_000 },
  );
  await store.send("r1", { kind: "steer", text: "first" });
  await until(() => seen.length === 1);
  await store.send("r1", { kind: "steer", text: "second" });
  const stopped = stop();
  releaseFirst();
  await stopped;
  assert.deepEqual(seen, ["first"], "nothing consumed after stop");
  assert.deepEqual(
    (await store.takePending("r1")).map((s) => s.text),
    ["second"],
    "the undrained signal is still pending",
  );
});

test("pg store: NOTIFY doorbell reaches a listener on a different connection", { skip }, async () => {
  const sender = createPostgresRunSignalStore(URL!);
  const receiver = createPostgresRunSignalStore(URL!);
  const runId = `test-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    let rings = 0;
    const off = receiver.onSignal(runId, () => rings++);
    await sleep(300);
    await sender.send(runId, { kind: "steer", text: "hello" });
    await until(() => rings >= 1);
    off();
    const taken = await receiver.takePending(runId);
    assert.deepEqual(taken, [{ kind: "steer", text: "hello" }], "the durable row is still the truth");
  } finally {
    await sender.close?.();
    await receiver.close?.();
  }
});

test("memory store: a signal round-trips ts and request intact", async () => {
  const store = createMemoryRunSignalStore();
  const request = {
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "channel" as const, threadRef: "ch:C1:1.1" },
    text: "why did you do it wrong?",
  };
  await store.send("r1", { kind: "steer", text: "why did you do it wrong?", ts: "1.2", request });
  const [taken] = await store.takePending("r1");
  assert.equal(taken!.ts, "1.2");
  assert.deepEqual(taken!.request, request);
});

test("pg store: a signal round-trips ts and request intact", { skip }, async () => {
  const store = createPostgresRunSignalStore(URL!);
  const runId = `test-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const request = {
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "channel" as const, threadRef: "ch:C1:1.1" },
    text: "why did you do it wrong?",
  };
  try {
    await store.send(runId, { kind: "steer", text: "why did you do it wrong?", ts: "1784151699.674169", request });
    const [taken] = await store.takePending(runId);
    assert.equal(taken!.ts, "1784151699.674169", "ts survives the pg round-trip (the inert-#1196 bug)");
    assert.deepEqual(taken!.request, request, "the stored surface request survives for orphan replay");
  } finally {
    await store.close?.();
  }
});

test("pg signal send commits or rolls back its acceptance outbox atomically", { skip }, async () => {
  const store = createPostgresRunSignalStore(URL!);
  const outbox = createPostgresTransactionalOutbox(URL!);
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const runId = `atomic-signal-${nonce}`;
  const accepted = createTransactionalOutboxEntry({
    id: `accept-signal-${nonce}`,
    topic: "test.signal.accepted",
    payloadJson: JSON.stringify({ accepted: true }),
    createdAt: Date.now(),
  });
  try {
    await store.send(runId, { kind: "steer", text: "accepted" }, accepted);
    assert.equal((await outbox.get(accepted.id))?.state, "pending");
    assert.equal((await store.takePending(runId)).length, 1);

    const collisionId = `accept-signal-collision-${nonce}`;
    await outbox.stage(
      createTransactionalOutboxEntry({
        id: collisionId,
        topic: "test.signal.accepted",
        payloadJson: JSON.stringify({ version: 1 }),
        createdAt: Date.now(),
      }),
    );
    const failedRunId = `atomic-signal-rollback-${nonce}`;
    await assert.rejects(
      store.send(
        failedRunId,
        { kind: "steer", text: "must roll back" },
        createTransactionalOutboxEntry({
          id: collisionId,
          topic: "test.signal.accepted",
          payloadJson: JSON.stringify({ version: 2 }),
          createdAt: Date.now(),
        }),
      ),
      /identity is already bound/u,
    );
    assert.deepEqual(await store.takePending(failedRunId), []);
  } finally {
    await store.close?.();
    await outbox.close?.();
  }
});

test("memory store: pendingRunIds lists runs with unconsumed signals; prune is a no-op", async () => {
  const store = createMemoryRunSignalStore();
  await store.send("r1", { kind: "steer", text: "a" });
  await store.send("r2", { kind: "abort" });
  assert.deepEqual((await store.pendingRunIds()).sort(), ["r1", "r2"]);
  await store.takePending("r1");
  assert.deepEqual(await store.pendingRunIds(), ["r2"]);
  await store.prune(0);
  assert.deepEqual(await store.pendingRunIds(), ["r2"], "prune never touches unconsumed signals");
});

test("pg store: pendingRunIds lists unconsumed runs; prune deletes only old consumed rows", { skip }, async () => {
  const store = createPostgresRunSignalStore(URL!);
  const a = `test-run-${Date.now()}-a-${Math.random().toString(36).slice(2)}`;
  const b = `test-run-${Date.now()}-b-${Math.random().toString(36).slice(2)}`;
  try {
    await store.send(a, { kind: "steer", text: "x" });
    await store.send(b, { kind: "steer", text: "y" });
    const pending = await store.pendingRunIds();
    assert.ok(pending.includes(a) && pending.includes(b));
    await store.takePending(a);
    await store.prune(0);
    const after = await store.pendingRunIds();
    assert.ok(!after.includes(a), "consumed and pruned");
    assert.ok(after.includes(b), "unconsumed survives any prune");
    assert.equal((await store.takePending(b)).length, 1, "the surviving signal is intact");
  } finally {
    await store.close?.();
  }
});
