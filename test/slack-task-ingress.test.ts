import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createDurableTasks } from "../src/durable/tasks.ts";
import { createSlackIngress, slackIngressKey } from "../src/slack/task-ingress.ts";
import { createHttpEventsReceiver } from "../src/slack/http-events.ts";

test("Slack acceptance persists a complete interaction before its worker runs and deduplicates redelivery", async () => {
  const tasks = createDurableTasks({ queue: "ingress-test" });
  const ingress = createSlackIngress(tasks);
  const body = {
    type: "block_actions",
    trigger_id: "trigger-1",
    user: { id: "U1" },
    actions: [{ action_id: "hilo_allow_once", value: "approval-1" }],
  };
  let executed = 0;
  ingress.register("bot-1", async (received, gate) => {
    assert.deepEqual(received, body);
    executed++;
    gate.persisted();
  });
  await ingress.accept("bot-1", body);
  await ingress.accept("bot-1", body);
  assert.equal(executed, 0);
  const task = await tasks.spawn(
    "slack.ingest",
    { account: "bot-1", body },
    { idempotencyKey: slackIngressKey("bot-1", body) },
  );
  const worker = tasks.start({ pollIntervalMs: 1 });
  try {
    await tasks.result(task.taskId);
    assert.equal(executed, 1);
  } finally {
    await worker.stop();
    await tasks.close();
  }
});

test("source identities isolate otherwise identical Slack events", () => {
  const body = { type: "event_callback", event_id: "Ev1" };
  assert.notEqual(slackIngressKey("first", body), slackIngressKey("second", body));
  assert.notEqual(slackIngressKey("first", body), slackIngressKey("first", { ...body, event_id: "Ev2" }));
});

test("HTTP interaction ACK waits for the durable commit and failed acceptance remains retryable", async () => {
  let release: (() => void) | undefined;
  let fail = false;
  const persisted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const accepted: Record<string, unknown>[] = [];
  const secret = "test-ingress-signature";
  const receiver = createHttpEventsReceiver({
    signingSecret: secret,
    port: 0,
    accept: async (body) => {
      await persisted;
      if (fail) throw new Error("database unavailable");
      accepted.push(body);
    },
  });
  await receiver.start(0 as never);
  const address = receiver.server.address();
  assert.ok(address && typeof address === "object");
  const body = {
    type: "block_actions",
    trigger_id: "click-1",
    user: { id: "U1" },
    actions: [{ action_id: "hilo_allow_once", value: "approval-1" }],
  };
  const raw = new URLSearchParams({ payload: JSON.stringify(body) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  const send = () =>
    fetch(`http://127.0.0.1:${address.port}/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: raw,
    });
  try {
    let replied = false;
    const response = send().then((result) => {
      replied = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(replied, false);
    release!();
    assert.equal((await response).status, 200);
    assert.deepEqual(accepted, [body]);
    fail = true;
    assert.equal((await send()).status, 503);
  } finally {
    await receiver.stop();
  }
});

test("Slack ingress keeps its replay alive after durable admission until the handler settles", async () => {
  const { assertOperationActive, withTimeout } = await import("../src/util/async.ts");
  const tasks = createDurableTasks({ queue: "ingress-lifetime-test" });
  const ingress = createSlackIngress(tasks);
  const body = { type: "event_callback", event_id: "lifetime" };
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let completed = false;
  ingress.register("bot", async (_, gate) => {
    gate.persisted();
    admitted.resolve();
    await release.promise;
    assertOperationActive();
    completed = true;
  });
  const task = await tasks.spawn(
    "slack.ingest",
    { account: "bot", body },
    { idempotencyKey: slackIngressKey("bot", body) },
  );
  const worker = tasks.start({ pollIntervalMs: 1 });
  try {
    await admitted.promise;
    await worker.stopClaims();
    let drained = false;
    const draining = worker.drained().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    release.resolve();
    await withTimeout(() => draining, 1000, "ingress continuation finishes");
    await tasks.result(task.taskId);
    assert.equal(completed, true);
  } finally {
    release.resolve();
    await worker.stop();
    await tasks.close();
  }
});

test("a Slack parent waiting for its durable run yields immediately when deployment admission closes", async () => {
  const { createSlackCoreClient } = await import("../src/api/slack-core-client.ts");
  const { createHandoff } = await import("../src/runs/handoff.ts");
  const { durableTaskContext } = await import("../src/durable/tasks.ts");
  const handoff = createHandoff();
  let unsubscribed = false;
  const { createMemoryMap } = await import("../src/persistence/durable-map.ts");
  const client = createSlackCoreClient({
    agentRequests: createMemoryMap(),
    runs: { onTerminal() {} },
    turnStream: {
      subscribe: () => () => {
        unsubscribed = true;
      },
    },
  } as unknown as Parameters<typeof createSlackCoreClient>[0]);
  handoff.request(120000);
  const context = {
    signal: handoff.signals().deadline,
    handoff: handoff.signals(),
  } as import("../src/durable/tasks.ts").DurableTaskContext;
  assert.deepEqual(await durableTaskContext.run(context, () => client.waitRun("running")), {
    status: "queued",
    runId: "running",
  });
  assert.equal(unsubscribed, true);
});

test("durable Slack admission releases its only ingress slot before the agent finishes", async () => {
  const { createTurnFlow } = await import("../src/slack/turn-flow.ts");
  const { withTimeout } = await import("../src/util/async.ts");
  const tasks = createDurableTasks({ queue: "ingress-capacity-test" });
  const ingress = createSlackIngress(tasks);
  let polls = 0;
  let stops = 0;
  let acknowledgements = 0;
  const flow = createTurnFlow({
    durableDeliveries: true,
    submitTurn: async () => ({ status: "queued", runId: "still-running" }),
    waitRun: async () => {
      polls++;
      return new Promise(() => {});
    },
  } as unknown as Parameters<typeof createTurnFlow>[0]);
  ingress.register("bot", async (body, gate) => {
    if (body.text === "stop") {
      stops++;
      gate.persisted();
      return;
    }
    const result = await flow.callCore({ text: "long task" } as Parameters<typeof flow.callCore>[0], {
      onQueued: async () => {
        gate.persisted();
        await new Promise<void>((resolve) => setImmediate(resolve));
        acknowledgements++;
      },
    });
    assert.equal(result.status, "queued");
  });
  const first = await tasks.spawn(
    "slack.ingest",
    { account: "bot", body: { text: "long task" } },
    { idempotencyKey: "first" },
  );
  const second = await tasks.spawn(
    "slack.ingest",
    { account: "bot", body: { text: "stop" } },
    { idempotencyKey: "second" },
  );
  tasks.start({ concurrency: 1, pollIntervalMs: 1 });
  try {
    await withTimeout(
      () => Promise.all([tasks.result(first.taskId), tasks.result(second.taskId)]),
      1000,
      "stop admitted while turn runs",
    );
    assert.equal(polls, 0);
    assert.equal(stops, 1);
    assert.equal(acknowledgements, 1);
    assert.equal(flow.inFlightRuns.has("still-running"), false);
  } finally {
    await tasks.close();
  }
});

for (const scope of ["task", "operation"] as const) {
  test(`Slack preserves the exact ${scope} deadline cancellation without logging a failure`, async (t) => {
    const { createTurnFlow } = await import("../src/slack/turn-flow.ts");
    const { createHandoff } = await import("../src/runs/handoff.ts");
    const { durableTaskContext, isDurableControlFlow } = await import("../src/durable/tasks.ts");
    const { withAbort, withOperationSignal } = await import("../src/util/async.ts");
    const handoff = createHandoff();
    const signal = handoff.signals().deadline;
    const entered = Promise.withResolvers<void>();
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => logged.push(args));
    const flow = createTurnFlow({
      durableDeliveries: true,
      submitTurn: async () => {
        entered.resolve();
        return withAbort(() => new Promise(() => {}), signal);
      },
    } as unknown as Parameters<typeof createTurnFlow>[0]);
    const run = async () => {
      try {
        await flow.callCore({ text: "deadline" } as Parameters<typeof flow.callCore>[0]);
        assert.fail("cancelled Slack admission completed");
      } catch (error) {
        assert.equal(error, signal.reason);
        assert.equal(isDurableControlFlow(error), true);
        assert.equal(isDurableControlFlow(new Error("unrelated provider failure")), false);
      }
    };
    const pending =
      scope === "operation"
        ? withOperationSignal(signal, run)
        : durableTaskContext.run(
            { signal, handoff: handoff.signals() } as import("../src/durable/tasks.ts").DurableTaskContext,
            run,
          );
    await entered.promise;
    handoff.request(0);
    await pending;
    assert.deepEqual(logged, []);
  });
}
