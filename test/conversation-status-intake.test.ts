import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

let selectTask: string | undefined;
let arrivals = 0;
let release: (() => void) | undefined;
let barrier: Promise<void> | undefined;
mock.module("../src/wake/conversation-status.ts", {
  namedExports: {
    conversationFollowup: async ({
      request,
      relatedRuns,
    }: {
      request: OrchestratorInput;
      relatedRuns: import("../src/runs/run-store.ts").Run[];
    }) => {
      if (selectTask) return { target: relatedRuns.find((run) => run.id === selectTask)!, cancel: false };
      arrivals++;
      if (arrivals === 2) release?.();
      await barrier;
      return {
        request: {
          ...request,
          conversation: { ...request.conversation, threadRef: "dm:D1:status:test" },
          readOnly: true,
        },
      };
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

test("simultaneous status redeliveries have exactly one response owner", async () => {
  const built = buildApp(testConfig());
  try {
    const actor = { externalId: "U1" };
    const turn: TurnRequest = {
      surface: "slack",
      actor,
      conversation: { kind: "dm", threadRef: "dm:D1", audience: [actor] },
      text: "Build the website",
      async: true,
      liveActor: true,
      redeliveryKey: "slack:B:D1:1",
    };
    const first = await built.app.turn(turn);
    assert.equal(first.status, "queued");
    const session = await built.sessions.getOrCreateByThread("dm:D1", "dm", scopeId("personal", "U1"));
    await built.sessions.addParticipant(session.id, "U1");
    arrivals = 0;
    barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const message = { ...turn, text: "Any progress?", redeliveryKey: "slack:B:D1:2" };
    const results = await Promise.all([built.app.turn(message), built.app.turn(message)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["queued", "silent"]);
    assert.equal(results.find((result) => result.status === "queued")?.conversationAside, true);
    assert.equal((await built.signals.takePending(first.runId!)).length, 0);
    assert.equal((await built.runs.list()).length, 2);
  } finally {
    barrier = undefined;
    await built.runtime.stop();
  }
});

test("independent tasks remain addressable after the root ends, including terminal replay and continuation", async () => {
  const built = buildApp(testConfig());
  try {
    const actor = { externalId: "U1" };
    const turn: TurnRequest = {
      surface: "slack",
      actor,
      conversation: { kind: "dm", threadRef: "dm:D1", audience: [actor] },
      text: "Website",
      async: true,
      liveActor: true,
      redeliveryKey: "root",
    };
    const first = await built.app.turn(turn);
    const root = (await built.runs.claimById(first.runId!, "test", 60000))!;
    await built.runs.complete(root.id, root.leaseToken!, { status: "ok", reply: "Website complete" });
    const childRef = "dm:D1:task:email";
    const child = (
      await built.runs.enqueue({
        sessionId: childRef,
        request: {
          ...root.request,
          text: "Draft an email to Josh",
          deliveryTarget: "D1:10.1",
          conversation: { ...root.request.conversation, threadRef: childRef },
        },
      })
    ).run;
    selectTask = child.id;
    const update = await built.app.turn({
      ...turn,
      deliveryTarget: "D1:20.1",
      text: "Make the email shorter",
      redeliveryKey: "update",
    });
    assert.equal(update.runId, child.id);
    assert.equal(update.steered, true);
    const signals = await built.signals.takePending(child.id);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.request?.conversation.threadRef, childRef);
    assert.equal(signals[0]?.request?.deliveryTarget, "D1:10.1");
    const claimed = (await built.runs.claimById(child.id, "test", 60000))!;
    await built.runs.complete(child.id, claimed.leaseToken!, { status: "ok", reply: "Email draft" });
    const continuation = await built.app.turn({
      ...turn,
      text: "Make the email warmer",
      deliveryTarget: "D1:30.1",
      redeliveryKey: "continuation",
    });
    assert.equal(continuation.status, "queued");
    assert.equal((await built.runs.get(continuation.runId!))?.sessionId, childRef);
    assert.equal((await built.runs.get(continuation.runId!))?.request.deliveryTarget, "D1:10.1");
  } finally {
    selectTask = undefined;
    await built.runtime.stop();
  }
});

for (const excluded of [
  { name: "channel", conversation: { kind: "channel", channelRef: "C1" } },
  { name: "group DM", conversation: { kind: "group", channelRef: "G1", isMpim: true } },
  { name: "automation", triggered: true },
  { name: "spawned", spawned: true },
  { name: "bot", botActor: true },
  { name: "web", surface: "web" },
] as const) {
  test(`conversation routing excludes ${excluded.name} turns`, async () => {
    const built = buildApp(testConfig());
    try {
      const actor = { externalId: "U1" };
      const turn: TurnRequest = {
        surface: "slack",
        actor,
        text: "Build a website",
        async: true,
        liveActor: true,
        ...excluded,
        conversation: {
          kind: "dm",
          threadRef: `excluded:${excluded.name}`,
          audience: [actor],
          ...("conversation" in excluded ? excluded.conversation : {}),
        },
        redeliveryKey: "excluded-first",
      };
      await built.app.turn(turn);
      const before = arrivals;
      const second = await built.app.turn({ ...turn, text: "What is the status?", redeliveryKey: "excluded-second" });
      assert.equal(second.conversationAside, undefined);
      assert.equal(arrivals, before);
    } finally {
      await built.runtime.stop();
    }
  });
}

test("idle personal DM admissions reply at top level while explicit threads remain threads", async () => {
  const built = buildApp(testConfig());
  try {
    const actor = { externalId: "U1" };
    const turn: TurnRequest = {
      surface: "slack",
      actor,
      conversation: { kind: "dm", threadRef: "dm:D1", audience: [actor] },
      text: "How old was PG when founding YC?",
      async: true,
      liveActor: true,
      deliveryTarget: "D1:100.1",
      redeliveryKey: "idle-first",
    };
    const first = await built.app.turn(turn);
    assert.equal((await built.runs.get(first.runId!))?.request.deliveryTarget, "D1");
    const claimed = (await built.runs.claimById(first.runId!, "test", 60000))!;
    await built.runs.complete(claimed.id, claimed.leaseToken!, { status: "ok", reply: "40" });
    selectTask = first.runId;
    const followup = await built.app.turn({
      ...turn,
      text: "And when did he leave?",
      redeliveryKey: "idle-followup",
      deliveryTarget: "D1:100.2",
    });
    assert.equal((await built.runs.get(followup.runId!))?.request.deliveryTarget, "D1");
    const claimedFollowup = (await built.runs.claimById(followup.runId!, "test", 60000))!;
    await built.runs.complete(claimedFollowup.id, claimedFollowup.leaseToken!, { status: "ok", reply: "2014" });
    selectTask = followup.runId;
    const threaded = await built.app.turn({
      ...turn,
      text: "Tell me more",
      redeliveryKey: "explicit-followup",
      gatewayContext: { location: "DM", details: { thread_ts: "100.1" } },
    });
    assert.equal((await built.runs.get(threaded.runId!))?.request.deliveryTarget, "D1:100.1");
  } finally {
    selectTask = undefined;
    await built.runtime.stop();
  }
});
