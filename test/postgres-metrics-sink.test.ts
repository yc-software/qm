import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMetricsSink } from "../src/admin/postgres-metrics-sink.ts";
import { scopeId } from "../src/types.ts";
import { settle } from "./support/settle.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres metrics tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS turn_metrics CASCADE");
  await p.end();
});

test("pg metrics sink: persists samples, filters by scope + since, newest-first", { skip }, async () => {
  const sink = createPostgresMetricsSink(URL!);
  const s1 = scopeId("channel", "C1");
  const s2 = scopeId("channel", "C2");

  sink.record({
    totalMs: 100,
    ttftMs: 40,
    intakePreambleMs: 12,
    dispatchMs: 8,
    status: "ok",
    scopeLabel: s1,
    sessionId: "sess-A",
    turnSeq: 3,
    runId: "run-A",
    ingressMs: 70,
    detectMs: 40,
    compactMs: 15,
    queueMs: 9,
    resumedFromSeq: 1,
    execMs: 1500,
    streamMs: 620,
    leaseMs: 7,
    captureMs: 9000,
    credsMs: 55,
    compileMs: 33,
    cacheRead: 9000,
    cacheWrite: 0,
    uncachedInput: 1000,
  });
  sink.record({ totalMs: 200, status: "paused", scopeLabel: s2, sessionId: "sess-B" });
  await settle(async () => (await sink.list({ limit: 100 })).length === 2);

  const all = await sink.list({ limit: 100 });
  assert.equal(all.length, 2, "both samples persisted");
  assert.equal(all[0]!.scopeLabel, s2);
  assert.equal(all[0]!.status, "paused");
  assert.equal(all[0]!.ttftMs, undefined, "an absent TTFT stays absent (not 0)");
  assert.equal(all[0]!.intakePreambleMs, undefined, "absent intake stays absent");
  assert.equal(all[0]!.cacheRead, undefined, "absent cache telemetry stays absent (not 0)");
  assert.equal(all[0]!.execMs, undefined, "an absent execMs stays absent (not 0)");
  assert.equal(all[0]!.streamMs, undefined, "an absent streamMs stays absent (not 0)");
  assert.equal(all[0]!.leaseMs, undefined, "an absent leaseMs stays absent (not 0)");
  assert.equal(all[0]!.captureMs, undefined, "an absent captureMs stays absent (not 0)");

  const onlyS1 = await sink.list({ scopeId: s1, limit: 100 });
  assert.equal(onlyS1.length, 1, "scope filter narrows to one");
  assert.equal(onlyS1[0]!.totalMs, 100);
  assert.equal(onlyS1[0]!.ttftMs, 40, "captured TTFT round-trips");
  assert.equal(onlyS1[0]!.intakePreambleMs, 12, "captured intake preamble round-trips");
  assert.equal(onlyS1[0]!.dispatchMs, 8, "captured dispatch span round-trips");
  assert.equal(onlyS1[0]!.cacheRead, 9000, "captured cacheRead round-trips");
  assert.equal(onlyS1[0]!.cacheWrite, 0, "captured cacheWrite (0) round-trips, distinct from absent");
  assert.equal(onlyS1[0]!.uncachedInput, 1000, "captured uncachedInput round-trips");
  assert.equal(onlyS1[0]!.execMs, 1500, "captured execMs round-trips");
  assert.equal(onlyS1[0]!.streamMs, 620, "captured streamMs round-trips");
  assert.equal(onlyS1[0]!.leaseMs, 7, "captured leaseMs round-trips");
  assert.equal(onlyS1[0]!.captureMs, 9000, "captured captureMs round-trips");
  assert.equal(onlyS1[0]!.sessionId, "sess-A", "join key sessionId round-trips");
  assert.equal(onlyS1[0]!.turnSeq, 3, "join key turnSeq round-trips");
  assert.equal(onlyS1[0]!.credsMs, 55, "captured credsMs round-trips");
  assert.equal(onlyS1[0]!.compileMs, 33, "captured compileMs round-trips");
  assert.equal(onlyS1[0]!.runId, "run-A", "captured runId round-trips");
  assert.equal(onlyS1[0]!.ingressMs, 70, "captured ingressMs round-trips");
  assert.equal(onlyS1[0]!.detectMs, 40, "captured detectMs round-trips");
  assert.equal(onlyS1[0]!.compactMs, 15, "captured compactMs round-trips");
  assert.equal(onlyS1[0]!.queueMs, 9, "captured queueMs round-trips");
  assert.equal(onlyS1[0]!.resumedFromSeq, 1, "captured resumedFromSeq round-trips");
  assert.equal(all[0]!.ingressMs, undefined, "an absent ingressMs stays absent (not 0)");

  await sink.updateByRunId("run-A", { deliverMs: 42, slackInflightMs: 7 });
  const afterPatch = await sink.list({ scopeId: s1, limit: 100 });
  assert.equal(afterPatch[0]!.deliverMs, 42, "deliverMs patched by runId");
  assert.equal(afterPatch[0]!.slackInflightMs, 7, "slackInflightMs patched by runId");
  assert.equal(all[0]!.credsMs, undefined, "an absent credsMs stays absent (not 0)");
  assert.equal(all[0]!.compileMs, undefined, "an absent compileMs stays absent (not 0)");
  assert.equal(all[0]!.turnSeq, undefined, "an absent turnSeq stays absent");

  const onlySessA = await sink.list({ sessionId: "sess-A", limit: 100 });
  assert.equal(onlySessA.length, 1, "session filter narrows to one");
  assert.equal(onlySessA[0]!.totalMs, 100);

  const future = await sink.list({ since: Date.now() + 60_000, limit: 100 });
  assert.equal(future.length, 0, "nothing at/after a future cutoff");
});

test("pg metrics sink: survives a fresh sink over the same table (durability)", { skip }, async () => {
  const reopened = createPostgresMetricsSink(URL!);
  const rows = await reopened.list({ limit: 100 });
  assert.ok(rows.length >= 2, "samples written by a prior sink instance are still readable");
});

test("pg metrics sink: back-fills optional columns onto a pre-existing minimal table", { skip }, async () => {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS turn_metrics CASCADE");
  await p.query(
    `CREATE TABLE turn_metrics(
       id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, scope_label TEXT NOT NULL,
       status TEXT NOT NULL, total_ms INT NOT NULL)`,
  );
  await p.end();

  const sink = createPostgresMetricsSink(URL!);
  const s = scopeId("channel", "C1");
  sink.record({
    totalMs: 100,
    ttftMs: 40,
    status: "ok",
    scopeLabel: s,
    sessionId: "sess-A",
    runId: "run-A",
    cacheWrite: 0,
  });
  await settle(async () => (await sink.list({ limit: 100 })).length === 1);

  const rows = await sink.list({ limit: 100 });
  assert.equal(rows.length, 1, "the sample landed on the back-filled table");
  assert.equal(rows[0]!.ttftMs, 40, "an optional column added by ALTER round-trips");
  assert.equal(rows[0]!.cacheWrite, 0, "a 0 in an added BIGINT column round-trips (not dropped)");
  assert.equal(rows[0]!.dispatchMs, undefined, "an absent optional column stays undefined");

  await sink.updateByRunId("run-A", { deliverMs: 42 });
  assert.equal((await sink.list({ limit: 100 }))[0]!.deliverMs, 42, "patch-by-runId works on the back-filled table");
});
