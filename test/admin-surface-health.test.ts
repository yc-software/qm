import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-health-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    config: built.config,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE_ADMIN = { "x-admin-actor": "admin-alice@default-org" };

test("surface health is exposed to admins and merged per patch", async () => {
  const s = start();
  try {
    await s.built.app.mergeSurfaceHealth("slack", { grantedScopes: ["chat:write"], missingScopes: ["channels:read"] });
    await s.built.app.mergeSurfaceHealth("slack", { lastSyncOk: false, lastSyncError: "missing_scope" });

    const r = await fetch(`${s.base}/v1/admin/surface-health`, { headers: ALICE_ADMIN });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.deepEqual(d.surfaceHealth.slack.missingScopes, ["channels:read"]);
    assert.equal(d.surfaceHealth.slack.lastSyncOk, false);
    assert.equal(d.surfaceHealth.slack.lastSyncError, "missing_scope");
    assert.ok(d.surfaceHealth.slack.updatedAt > 0);

    const scopes = await fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN });
    const sd: any = await scopes.json();
    assert.equal(sd.surfaceHealth.slack.lastSyncError, "missing_scope");
  } finally {
    await s.close();
  }
});

test("surface health requires an admin", async () => {
  const s = start();
  try {
    const r = await fetch(`${s.base}/v1/admin/surface-health`, { headers: { "x-admin-actor": "mallory@default-org" } });
    assert.equal(r.status, 403);
  } finally {
    await s.close();
  }
});
