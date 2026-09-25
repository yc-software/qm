import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitBackgroundWork,
  mutateBackgroundWork,
  parseBackgroundWorkStatus,
  type BackgroundWorkStatus,
  type BackgroundWorkTransport,
} from "../src/background-work.ts";

const state = (): BackgroundWorkStatus => ({
  protocol: 1,
  enabled: true,
  deploymentId: "new-cohort",
  instanceId: "new-instance",
  generation: 2,
  desiredDeploymentId: "new-cohort",
  lastRequestId: "our-request",
  members: [
    {
      instanceId: "old-instance",
      taskArn: "old-task",
      deploymentId: "old-cohort",
      generation: 1,
      state: "relinquished",
      retired: false,
      ready: true,
    },
    {
      instanceId: "new-instance",
      taskArn: "new-task",
      deploymentId: "new-cohort",
      generation: 2,
      state: "admitted",
      retired: false,
      ready: true,
    },
  ],
});

const response = (value: BackgroundWorkStatus) => ({ status: 200, body: JSON.stringify(value) });

test("ownership status refuses stale responders and malformed durable membership", () => {
  assert.equal(parseBackgroundWorkStatus(JSON.stringify(state()), "new-cohort").generation, 2);
  assert.throws(() => parseBackgroundWorkStatus(JSON.stringify(state()), "old-cohort"), /requested deployment/);
  const duplicate = state();
  duplicate.members.push(duplicate.members[0]!);
  assert.throws(() => parseBackgroundWorkStatus(JSON.stringify(duplicate), "new-cohort"), /duplicate/);
  const unenrolled = state();
  unenrolled.instanceId = "missing";
  assert.throws(() => parseBackgroundWorkStatus(JSON.stringify(unenrolled), "new-cohort"), /not enrolled/);
});

test("lost mutation responses require the exact request ID and generation on durable readback", async () => {
  const calls: string[] = [];
  const mutation = { expectedGeneration: 1, desiredDeploymentId: "new-cohort", requestId: "our-request" };
  let observed = state();
  const transport: BackgroundWorkTransport = async (method, body) => {
    calls.push(method);
    if (method === "POST") {
      assert.deepEqual(JSON.parse(body!), mutation);
      throw new Error("connection lost after commit");
    }
    return response(observed);
  };
  assert.equal((await mutateBackgroundWork(transport, "new-cohort", mutation)).generation, 2);
  assert.deepEqual(calls, ["POST", "GET"]);
  observed = { ...state(), lastRequestId: "someone-else" };
  await assert.rejects(mutateBackgroundWork(transport, "new-cohort", mutation), /changed concurrently/);
});

test("retirement acknowledgment binds every terminated instance, task and generation", async () => {
  const mutation = {
    expectedGeneration: 2,
    requestId: "retirement",
    terminatedMembers: [{ instanceId: "old-instance", taskArn: "old-task", generation: 1 }],
  };
  const observed = state();
  observed.lastRequestId = "retirement";
  observed.members[0]!.retired = true;
  const transport: BackgroundWorkTransport = async () => response(observed);
  assert.equal((await mutateBackgroundWork(transport, "new-cohort", mutation)).generation, 2);
  observed.members[0]!.taskArn = "different-task";
  await assert.rejects(mutateBackgroundWork(transport, "new-cohort", mutation), /unconfirmed/);
});

test("activation waits for every old owner and every expected new task without waiting for old turns to drain", async () => {
  const observed = state();
  observed.members[0]!.state = "admitted";
  let polls = 0;
  const transport: BackgroundWorkTransport = async () => {
    polls++;
    if (polls === 2) observed.members[0]!.state = "relinquished";
    if (polls === 3)
      observed.members.push({
        ...observed.members[1]!,
        instanceId: "second-instance",
        taskArn: "second-task",
        ready: false,
      });
    if (polls === 4) observed.members[2]!.ready = true;
    return response(observed);
  };
  const ready = await awaitBackgroundWork(
    transport,
    "new-cohort",
    { generation: 2, desiredDeploymentId: "new-cohort", taskArns: ["new-task", "second-task"] },
    { timeoutMs: 10_000, pollMs: 1 },
  );
  assert.equal(polls, 4);
  assert.equal(ready.members[0]!.state, "relinquished");
});

test("pause never infers unacknowledged owners dead and refuses concurrent generations", async () => {
  const observed = state();
  observed.desiredDeploymentId = null;
  observed.members[0]!.state = "admitted";
  observed.members[1]!.state = "drained";
  const transport: BackgroundWorkTransport = async () => response(observed);
  const expected = { generation: 2, desiredDeploymentId: null, taskArns: [] };
  await assert.rejects(
    awaitBackgroundWork(transport, "new-cohort", expected, { timeoutMs: 0, pollMs: 1 }),
    /no member was inferred dead/,
  );
  observed.members[0]!.state = "relinquished";
  assert.equal(
    (await awaitBackgroundWork(transport, "new-cohort", expected, { timeoutMs: 0, pollMs: 1 })).generation,
    2,
  );
  observed.generation = 3;
  await assert.rejects(
    awaitBackgroundWork(transport, "new-cohort", expected, { timeoutMs: 0, pollMs: 1 }),
    /changed while awaiting/,
  );
});

for (const mode of ["late-commit", "unavailable-read", "never-commits", "competitor", "rejected"] as const) {
  test(`mutation confirmation handles ${mode} without changing its request`, async () => {
    const mutation = { expectedGeneration: 1, desiredDeploymentId: "new-cohort", requestId: "our-request" };
    let posts = 0;
    let reads = 0;
    const old = {
      ...state(),
      generation: 1,
      desiredDeploymentId: "old-cohort",
      lastRequestId: "previous",
      members: state().members.map((member) => ({ ...member, generation: 1 })),
    };
    const transport: BackgroundWorkTransport = async (method, body) => {
      if (method === "POST") {
        posts++;
        assert.equal(body, JSON.stringify(mutation));
        if (mode === "rejected") return { status: 403, body: "denied" };
        if (posts > 1 && (mode === "late-commit" || mode === "unavailable-read")) return response(state());
        throw new Error("response timed out before commit");
      }
      reads++;
      if (mode === "unavailable-read") throw new Error("temporarily unavailable");
      if (mode === "competitor") return response({ ...state(), lastRequestId: "competitor" });
      return response(old);
    };
    if (mode === "late-commit" || mode === "unavailable-read") {
      assert.equal((await mutateBackgroundWork(transport, "new-cohort", mutation)).generation, 2);
      assert.equal(posts, 2);
      assert.equal(reads, 1);
    } else {
      await assert.rejects(
        mutateBackgroundWork(transport, "new-cohort", mutation),
        mode === "competitor" ? /changed concurrently/ : /unconfirmed.*automatic compensation is unsafe/,
      );
      assert.equal(posts, mode === "never-commits" ? 3 : 1);
    }
  });
}

test("readiness cannot replace the confirmed mutation identity with a same-generation retirement", async () => {
  const observed = { ...state(), lastRequestId: "operator-retirement" };
  await assert.rejects(
    awaitBackgroundWork(
      async () => response(observed),
      "new-cohort",
      {
        generation: 2,
        desiredDeploymentId: "new-cohort",
        taskArns: ["new-task"],
        lastRequestId: "our-request",
      },
      { timeoutMs: 0, pollMs: 1 },
    ),
    /changed while awaiting/,
  );
});
