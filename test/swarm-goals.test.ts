import { test } from "node:test";
import assert from "node:assert/strict";
import { assignedGoal } from "../src/harness/goal.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

const goal = { objective: "Survey every archive for the lane", floor: { minMs: 3_600_000 }, token_cap: 2_000_000 };

test("a spawn goal reaches the worker turn without the swarm turn deadline", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "initial", text: "work", goal });
  await f.service.sweep();
  const run = (await f.runs.list()).find((item) => item.request.swarm)!;
  const message = (await f.store.get(f.root.id))!.messages[0]!;
  assert.deepEqual(run.request.swarmGoal, { ...goal, assignedAt: message.createdAt });
  assert.equal(run.request.turnWallClockMs, undefined);
  assert.ok(await f.service.binding({ ...run.request, runId: run.id }));
  await assert.rejects(f.service.binding({ ...run.request, runId: run.id, turnWallClockMs: 600_000 }));
});

test("goals are validated and only a parent may assign them to its own workers", async () => {
  const f = await swarmFixture();
  const [first, second] = await f.service.spawn(f.caller, { requestId: "initial", count: 2, text: "work" });
  await f.service.sweep();
  const { token_cap: _cap, ...uncapped } = goal;
  await assert.rejects(
    f.service.spawn(f.caller, { requestId: "uncapped", text: "work", goal: uncapped }),
    /require token_cap/,
  );
  await assert.rejects(
    f.service.spawn(f.caller, { requestId: "bad", text: "work", goal: { ...goal, token_cap: "lots" } }),
    /invalid goal/,
  );
  await assert.rejects(
    f.service.send(f.caller, { requestId: "silent", audience: [first!.id], text: "go", notify: false, goal }),
    /needs notify/,
  );
  await assert.rejects(
    f.service.send(f.caller, { requestId: "self", audience: [f.root.id], text: "go", goal }),
    /own workers/,
  );
  const peer = await f.workerCaller(first!.id);
  await assert.rejects(
    f.service.send(peer, { requestId: "sibling", audience: [second!.id], text: "go", goal }),
    /own workers/,
  );
  const sent = await f.service.send(f.caller, { requestId: "assign", audience: [second!.id], text: "go", goal });
  assert.deepEqual(sent.goal, goal);
});

test("each goal message installs once, and a later goal message wins", () => {
  const a = { objective: "A", token_cap: 100, assignedAt: 1_000 };
  const b = { objective: "B", token_cap: 100, assignedAt: 2_000 };
  const installedA = assignedGoal(undefined, a)!;
  assert.equal(installedA.objective, "A");
  assert.equal(assignedGoal({ ...installedA, status: "complete", tokensUsed: 100 }, a), null);
  const installedB = assignedGoal(installedA, b)!;
  assert.equal(installedB.objective, "B");
  assert.equal(assignedGoal(installedB, a), null);
});

test("goal fields outside the goal schema are rejected", async () => {
  const f = await swarmFixture();
  await assert.rejects(
    f.service.spawn(f.caller, { requestId: "extra", text: "work", goal: { ...goal, surprise: 1 } }),
    /invalid goal/,
  );
});
