import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "core-signing-secret".repeat(3);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "turn-metrics-")) }));
const core = createServer(built.app, {
  signingSecret: SECRET,
  webhookReceiver: built.webhookReceiver,
  metrics: built.metrics,
});
core.listen(0);
const coreBase = `http://localhost:${(core.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => core.close(() => r()));
  await built.runtime.stop();
});

const path = (runId: string): string => `/v1/turns/${encodeURIComponent(runId)}/metrics`;

test("POST /v1/turns/:runId/metrics patches the row by runId (source-authed)", async () => {
  built.metrics.record({
    totalMs: 100,
    status: "ok",
    scopeLabel: scopeId("channel", "C1"),
    sessionId: "sess-1",
    runId: "run-1",
  });

  const raw = JSON.stringify({ deliverMs: 42, slackInflightMs: 7 });
  const r = await fetch(`${coreBase}${path("run-1")}`, {
    method: "POST",
    headers: signedHeaders(SECRET, "POST", path("run-1"), raw),
    body: raw,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });

  const rows = await built.metrics.list({ sessionId: "sess-1", limit: 10 });
  const patched = rows.find((m) => m.runId === "run-1")!;
  assert.equal(patched.deliverMs, 42, "deliverMs landed on the row");
  assert.equal(patched.slackInflightMs, 7, "slackInflightMs landed on the row");
});

test("POST /v1/turns/:runId/metrics rejects an unsigned request 401", async () => {
  const raw = JSON.stringify({ deliverMs: 1 });
  const r = await fetch(`${coreBase}${path("run-1")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  assert.equal(r.status, 401, "source-auth is required");
});

test("POST /v1/turns/:runId/metrics with no measurable field is rejected 400", async () => {
  const raw = JSON.stringify({});
  const r = await fetch(`${coreBase}${path("run-1")}`, {
    method: "POST",
    headers: signedHeaders(SECRET, "POST", path("run-1"), raw),
    body: raw,
  });
  assert.equal(r.status, 400);
});
