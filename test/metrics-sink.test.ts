import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetricsSink } from "../src/admin/metrics-sink.ts";
import { scopeId } from "../src/types.ts";

test("in-RAM metrics sink: new columns round-trip through record→list", async () => {
  const sink = createMetricsSink();
  const s1 = scopeId("channel", "C1");

  sink.record({
    totalMs: 100,
    status: "ok",
    scopeLabel: s1,
    sessionId: "sess-A",
    turnSeq: 3,
    credsMs: 55,
    compileMs: 33,
    layersMs: 12,
    runId: "run-A",
    ingressMs: 70,
    detectMs: 40,
    compactMs: 15,
    queueMs: 9,
    resumedFromSeq: 1,
  });
  sink.record({ totalMs: 200, status: "ok", scopeLabel: s1, sessionId: "sess-B" });

  const all = await sink.list({ limit: 100 });
  const a = all.find((m) => m.sessionId === "sess-A")!;
  assert.equal(a.turnSeq, 3, "join key turnSeq round-trips");
  assert.equal(a.credsMs, 55, "credsMs round-trips");
  assert.equal(a.compileMs, 33, "compileMs round-trips");
  assert.equal(a.layersMs, 12, "layersMs round-trips");
  assert.equal(a.runId, "run-A", "runId round-trips");
  assert.equal(a.ingressMs, 70, "ingressMs round-trips");
  assert.equal(a.detectMs, 40, "detectMs round-trips");
  assert.equal(a.compactMs, 15, "compactMs round-trips");
  assert.equal(a.queueMs, 9, "queueMs round-trips");
  assert.equal(a.resumedFromSeq, 1, "resumedFromSeq round-trips");

  const b = all.find((m) => m.sessionId === "sess-B")!;
  assert.equal(b.credsMs, undefined, "an absent credsMs stays absent (not 0)");
  assert.equal(b.compileMs, undefined, "an absent compileMs stays absent (not 0)");
  assert.equal(b.ingressMs, undefined, "an absent ingressMs stays absent (not 0)");
});

test("in-RAM metrics sink: updateByRunId patches the deliver/inflight report-back fields", async () => {
  const sink = createMetricsSink();
  const s1 = scopeId("channel", "C1");

  sink.record({ totalMs: 100, status: "ok", scopeLabel: s1, sessionId: "sess-A", runId: "run-X" });
  await sink.updateByRunId("run-X", { deliverMs: 42, slackInflightMs: 7 });
  await sink.updateByRunId("run-missing", { deliverMs: 999 });

  const rows = await sink.list({ limit: 100 });
  const patched = rows.find((m) => m.runId === "run-X")!;
  assert.equal(patched.deliverMs, 42, "deliverMs patched by runId");
  assert.equal(patched.slackInflightMs, 7, "slackInflightMs patched by runId");
});

test("in-RAM metrics sink: list({ sessionId }) filters to one session", async () => {
  const sink = createMetricsSink();
  const s1 = scopeId("channel", "C1");

  sink.record({ totalMs: 100, status: "ok", scopeLabel: s1, sessionId: "sess-A" });
  sink.record({ totalMs: 200, status: "ok", scopeLabel: s1, sessionId: "sess-B" });
  sink.record({ totalMs: 300, status: "ok", scopeLabel: s1, sessionId: "sess-A" });

  const onlyA = await sink.list({ sessionId: "sess-A", limit: 100 });
  assert.equal(onlyA.length, 2, "session filter narrows to the two sess-A rows");
  assert.ok(
    onlyA.every((m) => m.sessionId === "sess-A"),
    "every returned row is sess-A",
  );

  const onlyAFuture = await sink.list({ sessionId: "sess-A", since: Date.now() + 60_000, limit: 100 });
  assert.equal(onlyAFuture.length, 0, "a future cutoff excludes even matching-session rows");
});
