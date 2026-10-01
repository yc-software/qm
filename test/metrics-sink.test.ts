import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetricsSink } from "../src/admin/metrics-sink.ts";
import { scopeId } from "../src/types.ts";

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
