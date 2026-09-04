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
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-impersonate-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = "admin-alice@default-org";
const NOBODY = "user-uma@default-org";

const startImp = (base: string, actor: string, target: string) =>
  fetch(`${base}/v1/admin/impersonate`, {
    method: "POST",
    headers: { "x-admin-actor": actor, "content-type": "application/json" },
    body: JSON.stringify({ target }),
  });
const stopImp = (base: string, actor: string, target: string) =>
  fetch(`${base}/v1/admin/impersonate/stop`, {
    method: "POST",
    headers: { "x-admin-actor": actor, "content-type": "application/json" },
    body: JSON.stringify({ target }),
  });

test("an org admin can start impersonating a user; audited", async () => {
  const s = start();
  try {
    const r = await startImp(s.base, ALICE, "U-target");
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.target, "U-target");
    assert.ok(
      (await s.built.auditLog.events()).some(
        (e) => e.action === "impersonate.start" && e.resource === "U-target" && e.principalId === "admin-alice",
      ),
      "the start is recorded in the durable audit log",
    );
  } finally {
    await s.close();
  }
});

test("a non-admin cannot impersonate (403) — gated by the live grant store", async () => {
  const s = start();
  try {
    assert.equal((await startImp(s.base, NOBODY, "U-target")).status, 403);
    assert.equal((await stopImp(s.base, NOBODY, "U-target")).status, 403);
  } finally {
    await s.close();
  }
});

test("an admin cannot impersonate themselves (400)", async () => {
  const s = start();
  try {
    assert.equal((await startImp(s.base, ALICE, "admin-alice")).status, 400);
  } finally {
    await s.close();
  }
});

test("an empty target is rejected (400)", async () => {
  const s = start();
  try {
    assert.equal((await startImp(s.base, ALICE, "")).status, 400);
  } finally {
    await s.close();
  }
});

test("stopping impersonation is audited", async () => {
  const s = start();
  try {
    const r = await stopImp(s.base, ALICE, "U-target");
    assert.equal(r.status, 200);
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "impersonate.stop" && e.resource === "U-target"),
      "the stop is recorded in the durable audit log",
    );
  } finally {
    await s.close();
  }
});
