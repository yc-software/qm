import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { canonicalPayload } from "../plugins/chassis/src/source-auth-sign.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { buildApp } from "./support/build-app.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { testConfig } from "./support/test-config.ts";
import { testAdminGrantStore, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { TEST_ROOT_SCOPE, TEST_TENANT, OTHER_TENANT, TENANT_HEADERS } from "./support/tenant.ts";

function start(withAdmin = true, signingSecret?: string) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-whoami-")) }));
  const deps = {
    ...(withAdmin ? { admin: built.admin } : {}),
    auditLog: built.auditLog,
    tenantName: built.tenantName,
  };
  const server = signingSecret
    ? createServer(built.app, { replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()), ...deps, signingSecret })
    : createInsecureTestServer(TEST_TENANT, built.app, deps);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const whoami = (base: string, actor?: string): Promise<any> =>
  fetch(`${base}/v1/admin/whoami`, { headers: actor ? { "x-admin-actor": actor } : {} });

test("whoami reports an org_admin as admin with the org scope", async () => {
  const s = start();
  try {
    const r = await whoami(s.base, "admin-alice");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      isAdmin: true,
      role: "org_admin",
      scopeId: TEST_ROOT_SCOPE,
      permissions: ["admin"],
      tenant: TEST_TENANT,
      tenantName: `t-${TEST_TENANT.slice(-12)}`,
    });
  } finally {
    await s.close();
  }
});

test("whoami reports an ungranted actor as not-admin", async () => {
  const s = start();
  try {
    const r = await whoami(s.base, "U-nobody");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      isAdmin: false,
      permissions: [],
      tenant: TEST_TENANT,
      tenantName: `t-${TEST_TENANT.slice(-12)}`,
    });
  } finally {
    await s.close();
  }
});

test("whoami reports a foreign-org actor as not-admin (resolveActor null → 200, not 500/403)", async () => {
  const s = start();
  try {
    const r = await whoami(s.base, "admin-alice@other-org");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      isAdmin: false,
      permissions: [],
      tenant: TEST_TENANT,
      tenantName: `t-${TEST_TENANT.slice(-12)}`,
    });
  } finally {
    await s.close();
  }
});

test("whoami with no x-admin-actor is not-admin (200)", async () => {
  const s = start();
  try {
    const r = await whoami(s.base);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      isAdmin: false,
      permissions: [],
      tenant: TEST_TENANT,
      tenantName: `t-${TEST_TENANT.slice(-12)}`,
    });
  } finally {
    await s.close();
  }
});

test("whoami is 404 when the admin plane is unwired", async () => {
  const s = start(false);
  try {
    const r = await whoami(s.base, "admin-alice");
    assert.equal(r.status, 404);
  } finally {
    await s.close();
  }
});

test("whoami audits an admin.whoami event for a resolved actor", async () => {
  const s = start();
  try {
    await whoami(s.base, "admin-alice");
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
    const unsigned = await whoami(s.base, "admin-alice");
    assert.equal(unsigned.status, 401);

    const ts = Math.floor(Date.now() / 1000);
    const canonical = canonicalPayload("GET", "/v1/admin/whoami", "", TEST_TENANT);
    const identity = await mintPortalIdentity({ t: TEST_TENANT, p: "admin-alice", exp: Date.now() + 60_000 }, SECRET);
    const headers = (signature: string, tenant = TENANT_HEADERS) => ({
      ...tenant,
      "x-portal-identity": identity,
      "x-timestamp": String(ts),
      "x-signature": signature,
    });
    const forged = await fetch(`${s.base}/v1/admin/whoami`, {
      headers: headers(signRequest("not-the-secret", ts, canonical)),
    });
    assert.equal(forged.status, 401);

    const foreign = await fetch(`${s.base}/v1/admin/whoami`, {
      headers: headers(signRequest(SECRET, ts, canonicalPayload("GET", "/v1/admin/whoami", "", OTHER_TENANT)), {
        "x-qm-tenant": OTHER_TENANT,
      }),
    });
    assert.equal(foreign.status, 401, "an identity minted for one tenant is refused on another tenant's request");

    const ok = await fetch(`${s.base}/v1/admin/whoami`, { headers: headers(signRequest(SECRET, ts, canonical)) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      isAdmin: true,
      role: "org_admin",
      scopeId: TEST_ROOT_SCOPE,
      permissions: ["admin"],
      tenant: TEST_TENANT,
      tenantName: `t-${TEST_TENANT.slice(-12)}`,
    });
  } finally {
    await s.close();
  }
});

test("adminStatusOf reads the grant list directly (org_admin reported; non-admin otherwise)", async () => {
  const svc = createAdminService(testAdminGrantStore());
  const alice = svc.resolveActor("admin-alice")!;
  assert.deepEqual(await svc.adminStatusOf(alice), { isAdmin: true, role: "org_admin", scopeId: TEST_ROOT_SCOPE });
  const nobody = svc.resolveActor("U-nobody")!;
  assert.deepEqual(await svc.adminStatusOf(nobody), { isAdmin: false });
});
