import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-metrics-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    metrics: built.metrics,
    runs: built.runs,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = { "x-admin-actor": "admin-alice@default-org" };
const getJson = async (base: string, path: string, headers: Record<string, string> = ALICE): Promise<any> =>
  (await fetch(base + path, { headers })).json();

test("metrics: TTFT + latency populate after a driven turn, org-wide", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello there",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const m = await getJson(s.base, "/v1/admin/metrics?scope=org:default-org");
    assert.equal(m.scopeId, "org:default-org");

    assert.ok(m.ttft.count >= 1, "a TTFT sample was captured");
    assert.ok(typeof m.ttft.p50 === "number" && m.ttft.p50 >= 0, "TTFT p50 is a real number");
    assert.ok(m.turnLatency.count >= 1, "a total-turn-time sample was captured");
    assert.ok(typeof m.turnLatency.p95 === "number", "turn p95 populated");

    assert.ok(m.throughput.total >= 1, "the run is counted");
    assert.equal(m.throughput.done, m.throughput.total - m.throughput.failed);
    assert.equal(m.throughput.failureRate, m.throughput.total ? m.throughput.failed / m.throughput.total : 0);
    assert.ok(
      m.runLatency.count >= 1 && typeof m.runLatency.p50 === "number",
      "run execution latency derived from the queue",
    );

    assert.ok(Array.isArray(m.series) && m.series.length >= 1, "a daily series row exists");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(m.series[0].day), "series is keyed by UTC day");

    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "metrics.read"),
      "metrics.read is audited",
    );
  } finally {
    await s.close();
  }
});

test("metrics: empty scope yields null percentiles, not an error", async () => {
  const s = start();
  try {
    const m = await getJson(s.base, "/v1/admin/metrics?scope=personal:nobody");
    assert.equal(m.ttft.count, 0);
    assert.equal(m.ttft.p50, null);
    assert.equal(m.turnLatency.count, 0);
    assert.equal(m.throughput.failureRate, 0);
    assert.deepEqual(m.series, []);
    assert.equal(m.anatomy.traceA.samples, 0);
    assert.equal(m.anatomy.traceB.samples, 0);
    assert.equal(m.anatomy.composite.totalTurns, 0);
    assert.equal(m.anatomy.composite.provisionRate, 0);
    assert.equal(m.anatomy.composite.coldRate, 0);
    assert.equal(m.anatomy.traceA.total.avg, null);
  } finally {
    await s.close();
  }
});

test("metrics: turn anatomy splits no-sandbox (Trace A) from sandbox (Trace B) turns", async () => {
  const s = start();
  try {
    const chat: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:chat" },
      text: "hello there",
    };
    assert.equal((await s.built.app.turn(chat)).status, "ok");
    const tool: TurnRequest = {
      surface: "test",
      actor: { externalId: "U2" },
      conversation: { kind: "dm", threadRef: "dm:U2:tool" },
      text: "!run echo hi",
    };
    assert.equal((await s.built.app.turn(tool)).status, "ok");

    const m = await getJson(s.base, "/v1/admin/metrics?scope=org:default-org");
    const { traceA, traceB, composite } = m.anatomy;

    assert.ok(traceA.samples >= 1, "a Trace-A turn was captured");
    assert.ok(traceA.total.count >= 1 && typeof traceA.total.p50 === "number", "Trace-A total latency measured");
    assert.equal(traceA.modelCalls.avg, 1, "Trace-A is a single agent-loop step");
    assert.equal(traceA.toolCalls.avg, 0, "the chat turn made no tool calls (reported, not hardcoded)");
    assert.ok(traceA.stream.count >= 1, "Trace-A reply-generation span measured");
    assert.ok(typeof traceA.stream.p50 === "number" && traceA.stream.p50 >= 0, "stream span p50 is a real number");

    assert.ok(traceB.samples >= 1, "a Trace-B turn was captured");
    assert.ok((traceB.toolCalls.avg ?? 0) >= 1, "Trace-B made at least one tool call");
    assert.ok((traceB.modelCalls.avg ?? 0) >= 2, "Trace-B counts each agent-loop step, not just one");
    assert.ok(
      (traceB.modelCalls.avg ?? 0) > (traceA.modelCalls.avg ?? 0),
      "a tool turn has more model calls than a chat turn",
    );
    assert.ok(traceB.provision.count >= 1, "Trace-B provision time measured");
    assert.equal(traceB.cold + traceB.warm, traceB.samples, "every Trace-B turn is bucketed cold or warm");
    assert.ok(traceB.exec.count >= 1, "Trace-B execute round-trip measured");
    assert.ok(typeof traceB.exec.p50 === "number" && traceB.exec.p50 >= 0, "execute round-trip p50 is a real number");

    assert.equal(composite.totalTurns, traceA.samples + traceB.samples, "composite spans both archetypes");
    assert.ok(composite.provisionRate > 0 && composite.provisionRate < 1, "a mix of provisioned and not");
    assert.ok((composite.toolCalls.avg ?? 0) > 0, "composite tool-call average reflects the tool turn");

    assert.ok(Array.isArray(m.phases) && m.phases.length > 0, "per-phase breakdown present");
    const total = m.phases.find((p: any) => p.phase === "total");
    assert.ok(
      total.count >= 2 && typeof total.p50 === "number" && typeof total.p99 === "number",
      "total phase has percentiles",
    );
    assert.ok(
      Array.isArray(total.daily) && total.daily.length >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(total.daily[0].day),
      "daily percentiles keyed by UTC day",
    );
    assert.equal(
      total.dist.reduce((n: number, b: any) => n + b.count, 0),
      total.count,
      "distribution buckets partition the samples",
    );
    assert.ok(total.worst.length >= 1 && total.worst.length <= 8, "worst turns capped");
    assert.equal(total.worst[0].ms, Math.max(...total.worst.map((w: any) => w.ms)), "worst turns sorted slowest-first");
    assert.ok(
      total.worst.every((w: any) => typeof w.sessionId === "string" && w.scopeLabel),
      "worst turns link to their sessions",
    );
    const provision = m.phases.find((p: any) => p.phase === "provision");
    assert.ok(provision.count >= 1, "provision phase measured for the tool turn");
  } finally {
    await s.close();
  }
});

test("metrics: session+lease measured per turn; detached post-turn capture recorded separately", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U9" },
      conversation: { kind: "dm", threadRef: "dm:U9:cap" },
      text: "remember my favorite color is blue",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    let m = await getJson(s.base, "/v1/admin/metrics?scope=org:default-org");
    assert.ok(m.anatomy.traceA.lease.count >= 1, "session+lease measured on the turn");
    assert.ok(
      typeof m.anatomy.traceA.lease.p50 === "number" && m.anatomy.traceA.lease.p50 >= 0,
      "lease p50 is a real number",
    );

    for (let i = 0; i < 100 && (m.anatomy.capture.count ?? 0) < 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
      m = await getJson(s.base, "/v1/admin/metrics?scope=org:default-org");
    }
    assert.ok(m.anatomy.capture.count >= 1, "the detached post-turn capture was recorded");
    assert.ok(typeof m.anatomy.capture.p50 === "number" && m.anatomy.capture.p50 >= 0, "capture p50 is a real number");
    assert.equal(
      m.anatomy.traceA.samples + m.anatomy.traceB.samples,
      m.anatomy.composite.totalTurns,
      "capture samples don't inflate turn counts",
    );
  } finally {
    await s.close();
  }
});

test("metrics: authz is the boundary (scope grant required, scope required)", async () => {
  const s = start();
  try {
    assert.equal(
      (
        await fetch(s.base + "/v1/admin/metrics?scope=org:default-org", {
          headers: { "x-admin-actor": "user-uma@default-org" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(s.base + "/v1/admin/metrics?scope=org:default-org", {
          headers: { "x-admin-actor": "nobody@default-org" },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(s.base + "/v1/admin/metrics", { headers: ALICE })).status, 400);
  } finally {
    await s.close();
  }
});
