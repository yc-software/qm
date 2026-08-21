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
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cost-obs-")) }));
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

test("metrics: turn spend (output tokens + cost) is surfaced on the metrics endpoint", async () => {
  const s = start();
  try {
    const turn: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:c1" },
      text: "hello there",
    };
    assert.equal((await s.built.app.turn(turn)).status, "ok");

    const m = await getJson(s.base, "/v1/admin/metrics?scope=org:default-org");
    assert.ok(m.spend, "the metrics response carries a spend block");
    assert.ok(m.spend.samples >= 1, "the turn carried spend telemetry");
    assert.ok(m.spend.turnsWithKnownCost >= 1, "the mock harness reports known (if zero) cost");
    assert.ok(m.spend.outputTokensTotal > 0, "output tokens are summed per turn");
    assert.equal(typeof m.spend.costUsdTotal, "number", "cost total is numeric even when the mock reports 0");
  } finally {
    await s.close();
  }
});

test("metrics: an empty scope yields a present-but-empty spend block", async () => {
  const s = start();
  try {
    const m = await getJson(s.base, "/v1/admin/metrics?scope=personal:nobody");
    assert.ok(m.spend, "spend block is always present");
    assert.equal(m.spend.samples, 0);
    assert.equal(m.spend.turnsWithKnownCost, 0);
    assert.equal(m.spend.outputTokensTotal, 0);
    assert.equal(m.spend.costUsdTotal, 0);
  } finally {
    await s.close();
  }
});
