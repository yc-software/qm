import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import type { TurnRequest } from "../src/types.ts";
import { cacheHitRatio } from "../src/api/routes/admin/spend.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cache-obs-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    runs: built.runs,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = { "x-admin-actor": "admin-alice@default-org" };
const getJson = async (base: string, path: string, headers: Record<string, string> = ALICE): Promise<any> =>
  (await fetch(base + path, { headers })).json();

test("cacheHitRatio: read / (read + write + uncached); null when there's no telemetry", () => {
  assert.equal(cacheHitRatio({ cacheRead: 100, cacheWrite: 0, uncachedInput: 0 }), 1);
  assert.equal(cacheHitRatio({ cacheRead: 0, cacheWrite: 100, uncachedInput: 0 }), 0);
  assert.equal(cacheHitRatio({ cacheRead: 80, cacheWrite: 10, uncachedInput: 10 }), 0.8);
  assert.equal(cacheHitRatio({}), null);
  assert.equal(cacheHitRatio({ cacheRead: 0, cacheWrite: 0, uncachedInput: 0 }), null);
});

test("history /llm: per-call usage (cacheRead/cacheWrite) is plumbed through to the viewer", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:llm" },
      text: "what's the weather",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const sess = await getJson(s.base, "/v1/admin/sessions?scope=org:default-org");
    const conv = sess.sessions[0];

    const d = await getJson(s.base, `/v1/admin/sessions/${encodeURIComponent(conv.id)}/llm?scope=org:default-org`);
    assert.ok(d.requests.length >= 1, "at least one captured request");
    const req = d.requests[0]!;
    assert.ok(req.usage && typeof req.usage === "object", "the captured request carries provider usage");
    assert.equal(typeof req.usage.cacheRead, "number", "cacheRead is exposed per call");
    assert.equal(typeof req.usage.cacheWrite, "number", "cacheWrite is exposed per call");
    assert.equal(typeof req.usage.input, "number", "non-cached input is exposed per call");
    assert.ok(req.usage.cacheRead > 0, "a warm turn served input from the prefix");
    assert.equal(req.usage.cacheWrite, 0, "a warm turn wrote nothing to the cache");
    const ratio = cacheHitRatio({
      cacheRead: req.usage.cacheRead,
      cacheWrite: req.usage.cacheWrite,
      uncachedInput: req.usage.input,
    });
    assert.ok(ratio !== null && ratio > 0 && ratio < 1, "the call serves cached prefix and uncached new context");
  } finally {
    await s.close();
  }
});
