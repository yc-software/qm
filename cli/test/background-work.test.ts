import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitBackgroundWork,
  parseBackgroundWorkStatus,
  setBackgroundOwner,
  type BackgroundWorkStatus,
  type BackgroundWorkTransport,
} from "../src/background-work.ts";

const state = (patch: Partial<BackgroundWorkStatus> = {}): BackgroundWorkStatus => ({
  protocol: 2,
  deploymentId: "new-cohort",
  instanceId: "new-instance",
  ownerDeploymentId: "new-cohort",
  setAt: "2026-10-04T00:00:00.000Z",
  setBy: "new-cohort",
  active: true,
  ...patch,
});

const response = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });

test("ownership status refuses other responders and malformed records", () => {
  assert.deepEqual(parseBackgroundWorkStatus(JSON.stringify(state()), "new-cohort"), state());
  assert.throws(() => parseBackgroundWorkStatus(JSON.stringify(state()), "old-cohort"), /requested deployment/);
  assert.throws(() => parseBackgroundWorkStatus("not json", "new-cohort"), /invalid JSON/);
  for (const patch of [
    { protocol: 3 },
    { ownerDeploymentId: 4 },
    { ownerDeploymentId: "" },
    { active: "yes" },
    { setAt: 12 },
    { instanceId: "" },
  ])
    assert.throws(
      () => parseBackgroundWorkStatus(JSON.stringify({ ...state(), ...patch }), "new-cohort"),
      /does not match/,
    );
  const paused = parseBackgroundWorkStatus(
    JSON.stringify(state({ ownerDeploymentId: null, active: false })),
    "new-cohort",
  );
  assert.equal(paused.ownerDeploymentId, null);
});

test("a member-protocol responder is read as its enabled desired owner", () => {
  const legacy = {
    protocol: 1,
    enabled: true,
    deploymentId: "old-cohort",
    instanceId: "old-instance",
    generation: 4,
    desiredDeploymentId: "old-cohort",
    lastRequestId: "handover",
    members: [
      {
        instanceId: "old-instance",
        taskArn: "old-task",
        deploymentId: "old-cohort",
        generation: 4,
        state: "admitted",
        retired: false,
        ready: true,
      },
    ],
  };
  const parsed = parseBackgroundWorkStatus(JSON.stringify(legacy), "old-cohort");
  assert.equal(parsed.protocol, 2);
  assert.equal(parsed.ownerDeploymentId, "old-cohort");
  assert.equal(parsed.active, true);
  assert.equal(parsed.setAt, null);
  legacy.members[0]!.state = "relinquished";
  assert.equal(parseBackgroundWorkStatus(JSON.stringify(legacy), "old-cohort").active, false);
  legacy.enabled = false;
  assert.equal(parseBackgroundWorkStatus(JSON.stringify(legacy), "old-cohort").ownerDeploymentId, null);
  const rewritten = { ...legacy, enabled: true, desiredDeploymentId: "new-cohort", members: [] };
  assert.deepEqual(parseBackgroundWorkStatus(JSON.stringify(rewritten), "old-cohort"), {
    protocol: 2,
    deploymentId: "old-cohort",
    instanceId: "old-instance",
    ownerDeploymentId: "new-cohort",
    setAt: null,
    setBy: null,
    active: false,
  });
  assert.throws(
    () => parseBackgroundWorkStatus(JSON.stringify({ ...legacy, members: "none" }), "old-cohort"),
    /does not match/,
  );
});

test("a lost change response is confirmed by reading the owner back", async () => {
  const calls: string[] = [];
  const change = { ownerDeploymentId: "new-cohort", expectedOwnerDeploymentId: "old-cohort" };
  let observed = state();
  const transport: BackgroundWorkTransport = async (method, body) => {
    calls.push(method);
    if (method === "POST") {
      assert.deepEqual(JSON.parse(body!), change);
      throw new Error("connection lost after commit");
    }
    return response(observed);
  };
  assert.equal((await setBackgroundOwner(transport, "new-cohort", change)).ownerDeploymentId, "new-cohort");
  assert.deepEqual(calls, ["POST", "GET"]);
  observed = state({ ownerDeploymentId: "someone-else" });
  await assert.rejects(setBackgroundOwner(transport, "new-cohort", change), /changed concurrently/);
});

for (const mode of ["late-commit", "unavailable-read", "never-commits", "competitor", "rejected"] as const) {
  test(`owner change confirmation handles ${mode} without changing its request`, async () => {
    const change = { ownerDeploymentId: "new-cohort", expectedOwnerDeploymentId: "old-cohort" };
    let posts = 0;
    let reads = 0;
    const old = state({ ownerDeploymentId: "old-cohort", active: false });
    const transport: BackgroundWorkTransport = async (method, body) => {
      if (method === "POST") {
        posts++;
        assert.equal(body, JSON.stringify(change));
        if (mode === "rejected") return { status: 403, body: "denied" };
        if (posts > 1 && (mode === "late-commit" || mode === "unavailable-read")) return response(state());
        throw new Error("response timed out before commit");
      }
      reads++;
      if (mode === "unavailable-read") throw new Error("temporarily unavailable");
      if (mode === "competitor") return response(state({ ownerDeploymentId: "competitor" }));
      return response(old);
    };
    if (mode === "late-commit" || mode === "unavailable-read") {
      assert.equal((await setBackgroundOwner(transport, "new-cohort", change)).ownerDeploymentId, "new-cohort");
      assert.equal(posts, 2);
      assert.equal(reads, 1);
    } else {
      await assert.rejects(
        setBackgroundOwner(transport, "new-cohort", change),
        mode === "competitor" ? /changed concurrently/ : /unconfirmed/,
      );
      assert.equal(posts, mode === "never-commits" ? 3 : 1);
    }
  });
}

test("activation waits for every expected process to report activity and refuses a changed owner", async () => {
  let polls = 0;
  const transport: BackgroundWorkTransport = async () => {
    polls++;
    const instanceId = polls % 2 ? "first" : "second";
    if (polls === 4) return response(state({ instanceId, active: false }));
    return response(state({ instanceId, active: polls >= 3 }));
  };
  const ready = await awaitBackgroundWork(
    transport,
    "new-cohort",
    { ownerDeploymentId: "new-cohort", active: true, instances: 2 },
    { timeoutMs: 10_000, pollMs: 1 },
  );
  assert.equal(polls, 6);
  assert.equal(ready.active, true);
  await assert.rejects(
    awaitBackgroundWork(
      async () => response(state({ ownerDeploymentId: "other" })),
      "new-cohort",
      { ownerDeploymentId: "new-cohort", active: true, instances: 1 },
      { timeoutMs: 0, pollMs: 1 },
    ),
    /changed while awaiting/,
  );
  await assert.rejects(
    awaitBackgroundWork(
      async () => response(state({ ownerDeploymentId: null, active: true })),
      "new-cohort",
      { ownerDeploymentId: null, active: false, instances: 1 },
      { timeoutMs: 0, pollMs: 1 },
    ),
    /timed out awaiting 1 new-cohort process\(es\) to stop background work; 0 confirmed/,
  );
});
