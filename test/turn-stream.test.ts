import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("accumulates deltas per run and isolates runs", () => {
  const s = createTurnStream();
  assert.equal(s.snapshot("r1"), null, "unknown run has no partial");
  s.publish("r1", "Hel");
  s.publish("r1", "lo");
  s.publish("r2", "world");
  assert.equal(s.snapshot("r1"), "Hello");
  assert.equal(s.snapshot("r2"), "world");
});

test("ignores empty deltas", () => {
  const s = createTurnStream();
  s.publish("r1", "");
  assert.equal(s.snapshot("r1"), null);
  s.publish("r1", "x");
  s.publish("r1", "");
  assert.equal(s.snapshot("r1"), "x");
});

test("publishBlockStart() joins text blocks with a paragraph break, never leads or doubles", () => {
  const s = createTurnStream();
  s.publishBlockStart("r1");
  assert.equal(s.snapshot("r1"), null, "a boundary before any text is a no-op");
  s.publish("r1", "First block.");
  s.publishBlockStart("r1");
  s.publishBlockStart("r1");
  s.publish("r1", "Second block.");
  assert.equal(s.snapshot("r1"), "First block.\n\nSecond block.", "blocks join with one break");
  s.publish("r1", "\n\n");
  s.publishBlockStart("r1");
  s.publish("r1", "Third.");
  assert.equal(s.snapshot("r1"), "First block.\n\nSecond block.\n\nThird.", "no double break after trailing one");
});

test("begin() marks a run replying BEFORE any token, without producing a partial", () => {
  const s = createTurnStream();
  assert.equal(s.replying("r1"), false, "unknown run is not replying");
  s.begin("r1");
  assert.equal(s.replying("r1"), true, "begin() commits to a reply");
  assert.equal(s.snapshot("r1"), null, "no partial yet — begin() is text-free");
  s.publish("r1", "Hi");
  assert.equal(s.replying("r1"), true);
  assert.equal(s.snapshot("r1"), "Hi", "the deferred text streams into the same entry");
});

test("a streamed delta implies replying even without an explicit begin()", () => {
  const s = createTurnStream();
  s.publish("r1", "Hello");
  assert.equal(s.replying("r1"), true, "a delta means the agent is replying");
});

test("begin() is idempotent and never clobbers buffered text", () => {
  const s = createTurnStream();
  s.publish("r1", "Hello");
  s.begin("r1");
  assert.equal(s.snapshot("r1"), "Hello");
  assert.equal(s.replying("r1"), true);
});

test("caps a run's buffer at maxChars", () => {
  const s = createTurnStream({ maxChars: 5 });
  s.publish("r1", "abc");
  s.publish("r1", "defghij");
  assert.equal(s.snapshot("r1"), "abcde", "buffer stops growing past the cap");
});

test("end() evicts a finished run's buffer after the grace period", async () => {
  const s = createTurnStream({ graceMs: 20 });
  s.publish("r1", "done reply");
  s.end("r1");
  assert.equal(s.snapshot("r1"), "done reply", "buffer survives during grace so a final poll catches up");
  await sleep(40);
  assert.equal(s.snapshot("r1"), null, "buffer evicted after grace");
});

test("a late delta after end() cancels eviction and keeps streaming", async () => {
  const s = createTurnStream({ graceMs: 20 });
  s.publish("r1", "a");
  s.end("r1");
  s.publish("r1", "b");
  await sleep(40);
  assert.equal(s.snapshot("r1"), "ab", "eviction was cancelled by the late delta");
});

test("alive() spans begin()..end() — true through a silent stretch, false once the turn ends", async () => {
  const s = createTurnStream({ graceMs: 20 });
  assert.equal(s.alive("r1"), false, "unknown run is not alive");
  s.begin("r1");
  assert.equal(s.alive("r1"), true, "alive from begin(), before any token");
  assert.equal(s.alive("r1"), true, "still alive while awaiting a long tool call with no new output");
  s.end("r1");
  assert.equal(s.alive("r1"), false, "not alive after end(), even inside the grace window");
  await sleep(40);
  assert.equal(s.alive("r1"), false, "still not alive after eviction");
});

test("a late delta after end() resurrects liveness along with the buffer", () => {
  const s = createTurnStream({ graceMs: 20 });
  s.begin("r1");
  s.end("r1");
  s.publish("r1", "b");
  assert.equal(s.alive("r1"), true, "a streaming delta means the turn is executing again");
});

test("markReplyDone flags the reply as final independently of the run lifecycle", () => {
  const s = createTurnStream();
  assert.equal(s.isReplyDone("r1"), false, "unknown run: reply not done");
  s.publish("r1", "the answer");
  assert.equal(s.isReplyDone("r1"), false, "streaming text alone doesn't mark the reply final");
  s.markReplyDone("r1");
  assert.equal(s.isReplyDone("r1"), true, "explicitly marked final");
  assert.equal(s.snapshot("r1"), "the answer", "the buffered reply is still readable");
});

test("a queued run surfaces replyComplete via getRun once the reply is final", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "ts-")),
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t1" },
      text: "hello",
      async: true,
    });
    const finished = await built.runs.waitFor(ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    const run = await built.app.getRun(ack.runId!);
    assert.equal(run?.replyComplete, true, "a completed reply is flagged replyComplete");
    assert.notEqual(run?.alive, true, "a finished turn is not reported alive");
  } finally {
    await built.runtime.stop();
  }
});

test("a queued tool-using run surfaces its activity + timings via getRun()", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "ts-")),
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t1" },
      text: "!run echo hi",
      async: true,
    });
    assert.equal(ack.status, "queued");
    const finished = await built.runs.waitFor(ack.runId!, 5_000);
    assert.equal(finished.status, "done");

    const run = await built.app.getRun(ack.runId!);
    const types = (run?.activity ?? []).map((a) => a.type);
    assert.ok(types.includes("tool_call"), "the execute tool_call was mirrored to the run's activity");
    assert.ok(types.includes("tool_result"), "the execute tool_result was mirrored too");
    assert.equal(typeof run?.startedAt, "number", "getRun surfaces when the run started");
    assert.equal(typeof run?.finishedAt, "number", "getRun surfaces when the run finished");
  } finally {
    await built.runtime.stop();
  }
});

test("getRun projects durable tasks for its surface poller", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "ts-")),
      workers: 0,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  const ack = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "task-view" },
    text: "hello",
    async: true,
  });
  await built.tasks.create({
    id: "task-1",
    sessionId: "task-view",
    originRunId: ack.runId!,
    title: "research",
    status: "in_progress",
  });

  assert.deepEqual((await built.app.getRun(ack.runId!))?.tasks, [
    { id: "task-1", title: "research", status: "in_progress" },
  ]);
});

test("a queued run exposes the agent's in-flight reply via getRun().partial", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "ts-")),
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t1" },
      text: "hello",
      async: true,
    });
    assert.equal(ack.status, "queued");
    assert.ok(ack.runId);

    const finished = await built.runs.waitFor(ack.runId!, 5_000);
    assert.equal(finished.status, "done");

    const run = await built.app.getRun(ack.runId!);
    assert.ok(run?.partial, "the agent's reply was streamed to the run");
    assert.equal(run!.partial, finished.result?.reply, "streamed partial matches the final reply");
  } finally {
    await built.runtime.stop();
  }
});

test("first block: captured until noteToolCall closes it; later text never leaks in", () => {
  const s = createTurnStream();
  assert.equal(s.firstBlock("r1"), null, "unknown run has no first block");
  s.publish("r1", "On it — ");
  s.publish("r1", "checking the logs.");
  assert.deepEqual(s.firstBlock("r1"), { text: "On it — checking the logs.", closed: false }, "open until a tool call");
  s.noteToolCall("r1");
  assert.deepEqual(
    s.firstBlock("r1"),
    { text: "On it — checking the logs.", closed: true },
    "the first tool call closes it",
  );
  s.publishBlockStart("r1");
  s.publish("r1", "Found it: deploy #4819.");
  assert.deepEqual(
    s.firstBlock("r1"),
    { text: "On it — checking the logs.", closed: true },
    "post-tool text stays out",
  );
});

test("first block: a second text block before any tool call disqualifies the harvest", () => {
  const s = createTurnStream();
  s.publish("r1", "First thought.");
  s.publishBlockStart("r1");
  s.publish("r1", "Second thought.");
  s.noteToolCall("r1");
  assert.deepEqual(
    s.firstBlock("r1"),
    { text: "First thought.", closed: false },
    "never closed — not a preamble to work",
  );
});

test("first block: a turn that goes straight to tools has none", () => {
  const s = createTurnStream();
  s.noteToolCall("r1");
  s.publishBlockStart("r1");
  s.publish("r1", "The answer.");
  assert.equal(s.firstBlock("r1"), null, "no text before the tool call → nothing to harvest");
});

test("surfacePosted: false until marked, then sticky for the run", () => {
  const s = createTurnStream();
  assert.equal(s.surfacePosted("r1"), false);
  s.markSurfacePosted("r1");
  assert.equal(s.surfacePosted("r1"), true);
  assert.equal(s.surfacePosted("r2"), false, "isolated per run");
});

test("a DM turn's opening text block rides getRun as firstBlock/firstBlockClosed", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "ts-")),
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-fb" },
      text: "!preamble On it — checking.",
      async: true,
    });
    const finished = await built.runs.waitFor(ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    const run = await built.app.getRun(ack.runId!);
    assert.equal(run?.firstBlock, "On it — checking.", "the opening block is exposed for the surface to harvest");
    assert.equal(run?.firstBlockClosed, true, "the tool call closed it");
    assert.ok(run?.partial?.includes("All clear — nothing broke."), "the final reply still streams as partial");
  } finally {
    await built.runtime.stop();
  }
});

test("a harvested first block is stripped from the final reply (never shown twice)", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "ts-")),
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-strip" },
      text: "!preamble On it — checking.",
      async: true,
    });
    const finished = await built.runs.waitFor(ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    assert.equal(finished.result?.reply, "All clear — nothing broke.", "the acked preamble is stripped from the reply");
  } finally {
    await built.runtime.stop();
  }
});

test("a long first block is harvested too (no length gate) and stripped from the reply", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "ts-")),
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  built.runtime.start();
  try {
    const long = "x".repeat(400);
    const ack = await built.app.turn({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-held" },
      text: `!preamble ${long}`,
      async: true,
    });
    const finished = await built.runs.waitFor(ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    assert.equal(
      finished.result?.reply,
      "All clear — nothing broke.",
      "the long acked preamble is stripped like any other",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a non-slack surface never strips the first block from the reply", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "ts-")),
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-web" },
      text: "!preamble On it — checking.",
      async: true,
    });
    const finished = await built.runs.waitFor(ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    assert.ok(
      finished.result?.reply?.startsWith("On it — checking."),
      "no ack was posted on this surface, so nothing is stripped",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("subscribe never fabricates liveness: alive stays false and nothing leaks for a run this instance is not executing", () => {
  const stream = createTurnStream();
  let posted = false;
  const unsubscribe = stream.subscribe("other-instance-run", { onSurfacePosted: () => (posted = true) });
  assert.equal(
    stream.alive("other-instance-run"),
    false,
    "only begin() may assert liveness (blue-green staleness check)",
  );
  unsubscribe();
  assert.equal(stream.alive("other-instance-run"), false);
  stream.subscribe("local-run", { onSurfacePosted: () => (posted = true) });
  stream.begin("local-run");
  stream.markSurfacePosted("local-run");
  assert.equal(posted, true, "listeners still fire for a run this instance executes");
});

test("a stale double-unsubscribe cannot evict a newer subscriber's listener set", () => {
  const stream = createTurnStream();
  const unsubscribe = stream.subscribe("r1", { onSurfacePosted: () => {} });
  unsubscribe();
  let posted = false;
  stream.subscribe("r1", { onSurfacePosted: () => (posted = true) });
  unsubscribe();
  stream.begin("r1");
  stream.markSurfacePosted("r1");
  assert.equal(posted, true, "the newer subscriber must still hear events after a stale unsubscribe fires twice");
});
