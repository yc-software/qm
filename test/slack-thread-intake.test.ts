import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function message(threadTs?: string, text = "Continue", key = crypto.randomUUID()): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: `dm:D1${threadTs ? `:${threadTs}` : ""}` },
    deliveryTarget: `D1${threadTs ? `:${threadTs}` : ""}`,
    text,
    async: true,
    liveActor: true,
    redeliveryKey: key,
  };
}

async function fixture() {
  const built = buildApp(testConfig());
  const first = await built.app.turn(message("10.1", "Investigate job"));
  const root = (await built.runs.get(first.runId!))!;
  async function legacy(name: string, target = "D1:20.1", actorId = root.request.actor.id) {
    const ref = `dm:D1:task:${name}`;
    return (
      await built.runs.enqueue({
        sessionId: ref,
        request: {
          ...root.request,
          actor: { ...root.request.actor, id: actorId },
          conversation: { ...root.request.conversation, threadRef: ref },
          deliveryTarget: target,
        },
      })
    ).run;
  }
  return { ...built, root, legacy };
}

test("top-level messages stay at top level while another thread is active", async () => {
  const b = await fixture();
  try {
    await b.legacy("older");
    const first = await b.app.turn(message(undefined, "This schedule is overwhelming"));
    const run = (await b.runs.get(first.runId!))!;
    assert.equal(run.sessionId, "dm:D1");
    assert.equal(run.request.deliveryTarget, "D1");
    const followup = await b.app.turn(message(undefined, "Can't you tell?"));
    assert.equal(followup.runId, run.id);
    assert.equal(followup.steered, true);
    assert.equal((await b.signals.takePending(b.root.id)).length, 0);
  } finally {
    await b.runtime.stop();
  }
});

test("explicit threads steer only their own active conversation", async () => {
  const b = await fixture();
  try {
    const other = await b.app.turn(message("30.1"));
    const update = await b.app.turn(message("10.1", "Are you there?"));
    assert.equal(update.runId, b.root.id);
    assert.equal(update.steered, true);
    assert.equal((await b.signals.takePending(other.runId!)).length, 0);
    const [signal] = await b.signals.takePending(b.root.id);
    assert.equal(signal?.request?.deliveryTarget, "D1:10.1");
  } finally {
    await b.runtime.stop();
  }
});

test("changing model accounts queues in the same Slack thread without steering the old account", async () => {
  const b = await fixture();
  try {
    const prior = (await b.runs.claimById(b.root.id, "test", 60000))!;
    await b.runs.complete(prior.id, prior.leaseToken!, { status: "ok", reply: "Done" });
    const old = (
      await b.runs.enqueue({
        sessionId: b.root.sessionId,
        request: { ...b.root.request, modelAccount: "openai" },
      })
    ).run;
    const update = await b.app.turn(message("10.1"));
    assert.notEqual(update.runId, old.id);
    assert.notEqual(update.steered, true);
    const queued = (await b.runs.get(update.runId!))!;
    assert.equal(queued.sessionId, b.root.sessionId);
    assert.equal(queued.request.deliveryTarget, "D1:10.1");
    assert.equal(queued.request.modelAccount, "company");
    assert.deepEqual(await b.signals.takePending(old.id), []);
  } finally {
    await b.runtime.stop();
  }
});
