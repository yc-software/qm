import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoalRecord } from "../src/harness/goal.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

const goal = { objective: "Survey every archive for the lane", floor: { minMs: 3_600_000 }, token_cap: 2_000_000 };

async function workerRuns(f: Awaited<ReturnType<typeof swarmFixture>>) {
  return (await f.runs.list()).filter((run) => run.request.swarm);
}

test("a spawn goal reaches the worker turn and lifts the swarm turn deadline", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "work", goal });
  await f.service.sweep();
  const [run] = await workerRuns(f);
  assert.ok(run);
  assert.deepEqual(run.request.swarmGoal, {
    objective: goal.objective,
    floor: goal.floor,
    capTokens: goal.token_cap,
  });
  assert.equal(run.request.turnWallClockMs, undefined);
  assert.ok(await f.service.binding({ ...run.request, runId: run.id }));
  const forged = { ...run.request, runId: run.id, swarmGoal: { ...run.request.swarmGoal!, capTokens: 1 } };
  await assert.rejects(f.service.binding(forged), /forged swarm provenance/);
  const deadlined = { ...run.request, runId: run.id, turnWallClockMs: 600_000 };
  await assert.rejects(f.service.binding(deadlined), /forged swarm provenance/);
  assert.equal((await f.store.get(f.root.id))!.messages[0]!.audience[0], worker!.id);
});

test("ordinary swarm turns keep the swarm turn deadline", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  await f.service.sweep();
  const [run] = await workerRuns(f);
  assert.equal(run!.request.turnWallClockMs, 600_000);
  assert.equal(run!.request.swarmGoal, undefined);
});

test("a worker with an active goal gets goal turns for later messages too", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  await f.service.sweep();
  const sessionId = (await f.store.get(f.root.id))!.members.find((m) => m.id === worker!.id)!.sessionId!;
  const { lease } = await f.sessions.acquireLease(sessionId);
  await f.sessions.setGoal(lease!, createGoalRecord({ objective: "Keep going", capTokens: 1000 }));
  await f.sessions.releaseLease(lease!);
  await f.service.send(f.caller, { requestId: "follow-up", audience: [worker!.id], text: "new lead" });
  await f.service.sweep();
  const later = (await workerRuns(f)).find((run) => run.request.text.includes("new lead"))!;
  assert.equal(later.request.turnWallClockMs, undefined);
  assert.equal(later.request.swarmGoal, undefined);
  assert.ok(await f.service.binding({ ...later.request, runId: later.id }));
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
    f.service.spawn(f.caller, { requestId: "extra", text: "work", goal: { ...goal, surprise: 1 } }),
    /unsupported goal field/,
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
  assert.equal(sent.goal?.capTokens, goal.token_cap);
});
