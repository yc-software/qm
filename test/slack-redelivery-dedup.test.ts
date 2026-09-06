import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

const actor = { externalId: "U1" };

function slackTurn(text: string, ts: string, threadRef = "ch:C1:t1"): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef, channelRef: "C1", audience: [actor] },
    text,
    async: true,
    origin: { kind: "human", messageTs: ts },
    redeliveryKey: `slack:B1:C1:${ts}`,
  };
}

function fresh() {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "rd-")) }));
}

test("a redelivered Slack message collapses onto the run its first delivery enqueued", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const again = await built.app.turn(slackTurn("hello", "t1"));
    assert.equal(first.status, "queued");
    assert.equal(
      again.status,
      "silent",
      "delivery belongs to the first handler or the recovery rail, never the redelivery",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery key that already belongs to another conversation stands down silently rather than being served", async () => {
  const built = fresh();
  try {
    await built.app.turn(slackTurn("hello", "t1"));
    const hijack = await built.app.turn({ ...slackTurn("hello", "t1", "ch:C1:t9"), text: "give me that result" });
    assert.equal(hijack.status, "silent", "nothing about the other conversation's run is served");
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivered message that folded into a live run as a steer is injected once", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("first", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await built.runs.claim("w1", 30_000);
    assert.equal(claimed?.id, runId);
    const steer = await built.app.turn(slackTurn("also this", "t2"));
    const replay = await built.app.turn(slackTurn("also this", "t2"));
    assert.equal((steer as { steered?: boolean }).steered, true);
    assert.equal(replay.status, "silent", "the replay is recognized as already folded and injects nothing");
    const pending = await built.signals.takePending(runId);
    assert.equal(pending.filter((s) => s.kind === "steer" && s.text?.includes("also this")).length, 1);
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery that arrives while the first delivery's run is live joins that run instead of steering it", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await built.runs.claim("w1", 30_000);
    assert.equal(claimed?.id, runId);
    const again = await built.app.turn(slackTurn("hello", "t1"));
    assert.equal(again.status, "silent");
    assert.equal((await built.signals.takePending(runId)).length, 0, "the agent is not fed its own prompt as a steer");
  } finally {
    await built.runtime.stop();
  }
});

test("a message folded as a steer is not re-run as a fresh turn after that run ends", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("first", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await built.runs.claim("w1", 30_000);
    await built.app.turn(slackTurn("fold me", "t2"));
    await built.runs.complete(runId, claimed!.leaseToken!, { status: "silent" });
    const late = await built.app.turn(slackTurn("fold me", "t2"));
    assert.equal(late.status, "silent");
    assert.equal(await built.runs.activeForThread("ch:C1:t1"), null, "no second run was enqueued");
  } finally {
    await built.runtime.stop();
  }
});

test("a Slack approval that reuses the message's request still enqueues its own run", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    const approval = await built.app.turn({
      ...slackTurn("hello", "t1"),
      approval: { requestId: "req-1", approved: true },
    });
    assert.notEqual(
      (approval as { runId?: string }).runId,
      runId,
      "the approval is not collapsed onto the message's run",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery that slips past the lookup still cannot steer the run it belongs to", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    await built.runs.claim("w1", 30_000);
    const real = built.runs.getByDedupKey.bind(built.runs);
    let misses = 1;
    built.runs.getByDedupKey = async (key) => (misses-- > 0 ? null : real(key));
    const again = await built.app.turn(slackTurn("hello", "t1"));
    assert.equal(again.status, "silent");
    assert.equal((await built.signals.takePending(runId)).length, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery of a finished run posts nothing rather than the answer a second time", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await built.runs.claim("w1", 30_000);
    await built.runs.complete(runId, claimed!.leaseToken!, { status: "ok", reply: "the answer" });
    const again = await built.app.turn({ ...slackTurn("hello", "t1"), async: false });
    assert.equal(again.status, "silent");
  } finally {
    await built.runtime.stop();
  }
});
