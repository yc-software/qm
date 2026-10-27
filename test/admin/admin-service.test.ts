import "../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInsecureTestServer, createServer } from "../../src/api/server.ts";
import { signRequest } from "../../src/auth/source-auth.ts";
import { buildApp } from "../support/build-app.ts";
import { createAdminService, parseAdminGrants } from "../../src/admin/admin-service.ts";
import { createAdminGrantStore } from "../../src/admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "../../src/admin/postgres-admin-grant-store.ts";
import { scopeId } from "../../src/types.ts";
import { testConfig } from "../support/test-config.ts";
import { testAdminGrantStore, testDatabaseUrl } from "../support/test-database.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { listenLocal } from "../support/listen-local.ts";

function start(withAdmin = true, signingSecret?: string) {
  const built = buildApp(testConfig());
  const deps = {
    ...(withAdmin ? { admin: built.admin } : {}),
    auditLog: built.auditLog,
  };
  const server = signingSecret
    ? createServer(built.app, { replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()), ...deps, signingSecret })
    : createInsecureTestServer(built.app, deps);
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const whoami = (base: string, actor?: string): Promise<any> =>
  fetch(`${base}/v1/admin/whoami`, { headers: actor ? { "x-admin-actor": actor } : {} });

test("whoami reports an org_admin as admin with the org scope", async () => {
  const s = start();
  try {
    const r = await whoami(s.base, "admin-alice@default-org");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await s.close();
  }
});

test("whoami reports an ungranted actor as not-admin", async () => {
  const s = start();
  try {
    const r = await whoami(s.base, "U-nobody@default-org");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { isAdmin: false, permissions: [] });
  } finally {
    await s.close();
  }
});

test("whoami reports a foreign-org actor as not-admin (resolveActor null → 200, not 500/403)", async () => {
  const s = start();
  try {
    const r = await whoami(s.base, "admin-alice@other-org");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { isAdmin: false, permissions: [] });
  } finally {
    await s.close();
  }
});

test("whoami with no x-admin-actor is not-admin (200)", async () => {
  const s = start();
  try {
    const r = await whoami(s.base);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { isAdmin: false, permissions: [] });
  } finally {
    await s.close();
  }
});

test("whoami is 404 when the admin plane is unwired", async () => {
  const s = start(false);
  try {
    const r = await whoami(s.base, "admin-alice@default-org");
    assert.equal(r.status, 404);
  } finally {
    await s.close();
  }
});

test("whoami audits an admin.whoami event for a resolved actor", async () => {
  const s = start();
  try {
    await whoami(s.base, "admin-alice@default-org");
    const actions = (await s.built.auditLog.events()).map((e) => e.action);
    assert.ok(actions.includes("admin.whoami"), "the whoami read is audited");
  } finally {
    await s.close();
  }
});

test("with a signing secret set, a whoami GET with a BAD/missing signature is 401", async () => {
  const SECRET = "whoami-signing-secret".repeat(3);
  const s = start(true, SECRET);
  try {
    const unsigned = await whoami(s.base, "admin-alice@default-org");
    assert.equal(unsigned.status, 401);

    const ts = Math.floor(Date.now() / 1000);
    const badSig = signRequest("not-the-secret", ts, `GET\n/v1/admin/whoami\n`);
    const forged = await fetch(`${s.base}/v1/admin/whoami`, {
      headers: { "x-admin-actor": "admin-alice@default-org", "x-timestamp": String(ts), "x-signature": badSig },
    });
    assert.equal(forged.status, 401);

    const goodSig = signRequest(SECRET, ts, `GET\n/v1/admin/whoami\n`);
    const ok = await fetch(`${s.base}/v1/admin/whoami`, {
      headers: { "x-admin-actor": "admin-alice@default-org", "x-timestamp": String(ts), "x-signature": goodSig },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await s.close();
  }
});

test("adminStatusOf reads the grant list directly (org_admin reported; non-admin otherwise)", async () => {
  const svc = createAdminService(testAdminGrantStore());
  const alice = svc.resolveActor("admin-alice@default-org")!;
  assert.deepEqual(await svc.adminStatusOf(alice), { isAdmin: true, role: "org_admin", scopeId: "org:default-org" });
  const nobody = svc.resolveActor("U-nobody@default-org")!;
  assert.deepEqual(await svc.adminStatusOf(nobody), { isAdmin: false });
});

test("parseAdminGrants: unset keeps the seeded defaults (returns undefined)", () => {
  assert.equal(parseAdminGrants(undefined, "default-org"), undefined);
});

test("parseAdminGrants: parses org_admin grants and skips malformed / removed-role entries", () => {
  const grants = parseAdminGrants(
    "U1:org_admin, U2:team_admin:team-eng, bad, U3:notarole, U5:org_admin",
    "default-org",
  );
  assert.deepEqual(grants, [
    { principalId: "U1", scopeId: scopeId("org", "default-org"), role: "org_admin" },
    { principalId: "U5", scopeId: scopeId("org", "default-org"), role: "org_admin" },
  ]);
  assert.deepEqual(parseAdminGrants("", "default-org"), []);
});

test("ADMIN_GRANTS-seeded admins resolve and authorize org-wide; non-admins do not", async () => {
  const store = createAdminGrantStore(createPostgresAdminGrantStore(testDatabaseUrl()), {
    seed: () => parseAdminGrants("U1:org_admin", "default-org") ?? [],
  });
  const svc = createAdminService(store);
  const u1 = svc.resolveActor("U1@default-org");
  const u2 = svc.resolveActor("U2@default-org");
  assert.ok(u1 && u2);
  assert.equal(await svc.canAdminister(u1, scopeId("org", "default-org")), true);
  assert.equal(await svc.canAdminister(u1, scopeId("channel", "eng")), true);
  assert.equal(await svc.canAdminister(u2, scopeId("org", "default-org")), false);
  assert.equal(
    await svc.canAdminister(svc.resolveActor("admin-alice@default-org")!, scopeId("org", "default-org")),
    false,
  );
});
