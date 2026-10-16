import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmFixture } from "./support/swarm-fixture.ts";

async function runFor(f: Awaited<ReturnType<typeof swarmFixture>>, memberId: string) {
  const swarm = (await f.store.get(f.root.id))!;
  const runId = swarm.messages
    .flatMap((message) => Object.entries(message.notifications))
    .filter(([id]) => id === memberId)
    .at(-1)![1].runId!;
  return (await f.runs.get(runId))!;
}

test("spawn chooses the model, effort and fast mode for the workers it creates", async () => {
  const f = await swarmFixture();
  const peers = await f.service.spawn(f.caller, {
    requestId: "initial",
    count: 2,
    text: "work",
    model: "gpt-6.1-sol",
    effort: "medium",
    fastMode: false,
  });
  assert.deepEqual(peers[0]!.runtime, { model: "gpt-6.1-sol", thinkingLevel: "medium", fastMode: false });
  await f.service.sweep();
  for (const peer of peers) {
    const run = await runFor(f, peer.id);
    assert.equal(run.request.model, "gpt-6.1-sol");
    assert.equal(run.request.thinkingLevel, "medium");
    assert.equal(run.request.fastMode, false);
  }
});

test("later spawns in the same swarm can pick different models", async () => {
  const f = await swarmFixture();
  const [plain] = await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  const [sol] = await f.service.spawn(f.caller, { requestId: "sol", text: "work", model: "gpt-6.1-sol" });
  const [opus] = await f.service.spawn(f.caller, { requestId: "opus", text: "work", model: "claude-opus-5-5" });
  await f.service.sweep();
  assert.equal(plain!.runtime, undefined);
  assert.equal((await runFor(f, plain!.id)).request.model, undefined);
  assert.equal((await runFor(f, sol!.id)).request.model, "gpt-6.1-sol");
  assert.equal((await runFor(f, opus!.id)).request.model, "claude-opus-5-5");
});

test("workers spawned by a worker inherit its runtime and replace only the fields they name", async () => {
  const f = await swarmFixture();
  const [parent] = await f.service.spawn(f.caller, {
    requestId: "initial",
    text: "work",
    model: "gpt-6.1-sol",
    effort: "medium",
    settings: { depth: 3 },
  });
  await f.service.sweep();
  const worker = await f.workerCaller(parent!.id);
  const [inherited] = await f.service.spawn(worker, { requestId: "child", text: "sub" });
  const [chosen] = await f.service.spawn(worker, { requestId: "child2", text: "sub", effort: "high" });
  assert.deepEqual(inherited!.runtime, { model: "gpt-6.1-sol", thinkingLevel: "medium" });
  assert.deepEqual(chosen!.runtime, { model: "gpt-6.1-sol", thinkingLevel: "high" });
});

test("spawn rejects malformed or unknown runtime choices before reserving workers", async () => {
  for (const bad of [
    { model: "" },
    { model: 3 },
    { model: "no-such-model-qa" },
    { effort: "sideways" },
    { fastMode: "no" },
  ]) {
    const f = await swarmFixture();
    await assert.rejects(f.service.spawn(f.caller, { requestId: "initial", text: "work", ...(bad as object) }));
    assert.equal(await f.store.get(f.root.id), null);
  }
});
