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
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-grants-")) }));
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
const BOB = "admin-bob@default-org";
const NOBODY = "user-uma@default-org";

const post = (base: string, actor: string, body: unknown) =>
  fetch(`${base}/v1/admin/grants`, {
    method: "POST",
    headers: { "x-admin-actor": actor, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const del = (base: string, actor: string, principalId: string, scope: string, role: string) =>
  fetch(
    `${base}/v1/admin/grants/${encodeURIComponent(principalId)}?scope=${encodeURIComponent(scope)}&role=${encodeURIComponent(role)}`,
    { method: "DELETE", headers: { "x-admin-actor": actor } },
  );
const whoami = async (base: string, actor: string): Promise<any> =>
  (await fetch(`${base}/v1/admin/whoami`, { headers: { "x-admin-actor": actor } })).json();

test("an org admin promotes a user to org_admin; whoami reflects it; audited", async () => {
  const s = start();
  try {
    const r = await post(s.base, ALICE, { principalId: "U1", role: "org_admin", scopeId: "org:default-org" });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.grant.grantedBy, "admin-alice");
    assert.deepEqual(await whoami(s.base, "U1@default-org"), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "grant.create" && e.resource === "U1/org_admin"),
    );
  } finally {
    await s.close();
  }
});

test("a team_admin grant is rejected (400) — the role is unsupported / not wired to data", async () => {
  const s = start();
  try {
    const r = await post(s.base, ALICE, { principalId: "U2", role: "team_admin", scopeId: "team:team-eng" });
    assert.equal(r.status, 400);
    assert.deepEqual(await whoami(s.base, "U2@default-org"), { isAdmin: false, permissions: [] });
  } finally {
    await s.close();
  }
});

test("a non-admin cannot grant (403) — grant mutation is org_admin only", async () => {
  const s = start();
  try {
    const r = await post(s.base, NOBODY, { principalId: "U3", role: "org_admin", scopeId: "org:default-org" });
    assert.equal(r.status, 403);
    assert.deepEqual(await whoami(s.base, "U3@default-org"), { isAdmin: false, permissions: [] });
    assert.equal(
      (await post(s.base, "U-nobody@default-org", { principalId: "U4", role: "org_admin", scopeId: "org:default-org" }))
        .status,
      403,
    );
  } finally {
    await s.close();
  }
});

test("malformed grants are rejected (400): bad role, removed role, scope mismatch, missing principal", async () => {
  const s = start();
  try {
    assert.equal(
      (await post(s.base, ALICE, { principalId: "U5", role: "superuser", scopeId: "org:default-org" })).status,
      400,
    );
    assert.equal(
      (await post(s.base, ALICE, { principalId: "U6", role: "org_admin", scopeId: "team:team-eng" })).status,
      400,
    );
    assert.equal(
      (await post(s.base, ALICE, { principalId: "U7", role: "team_admin", scopeId: "org:default-org" })).status,
      400,
    );
    assert.equal(
      (await post(s.base, ALICE, { principalId: "", role: "org_admin", scopeId: "org:default-org" })).status,
      400,
    );
  } finally {
    await s.close();
  }
});

test("revoke flips a promoted user back to non-admin; audited", async () => {
  const s = start();
  try {
    await post(s.base, ALICE, { principalId: "U1", role: "org_admin", scopeId: "org:default-org" });
    const r = await del(s.base, ALICE, "U1", "org:default-org", "org_admin");
    assert.equal(r.status, 200);
    assert.deepEqual(await whoami(s.base, "U1@default-org"), { isAdmin: false, permissions: [] });
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "grant.revoke" && e.resource === "U1/org_admin"),
    );
  } finally {
    await s.close();
  }
});

test("a cased stored grant is revoked by its canonical id (the delete follows the person, not the bytes)", async () => {
  const s = start();
  try {
    await post(s.base, ALICE, { principalId: "Jordan@Acme.test", role: "org_admin", scopeId: "org:default-org" });
    assert.deepEqual(await whoami(s.base, "jordan@acme.test@default-org"), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
    assert.equal((await del(s.base, ALICE, "jordan@acme.test", "org:default-org", "org_admin")).status, 200);
    assert.deepEqual(
      await whoami(s.base, "Jordan@Acme.test@default-org"),
      { isAdmin: false, permissions: [] },
      "the cased row was actually removed",
    );
  } finally {
    await s.close();
  }
});

test("the last-admin guard counts one person's case-variant grants as ONE admin", async () => {
  const s = start();
  try {
    assert.equal((await del(s.base, ALICE, "admin-bob", "org:default-org", "org_admin")).status, 200);
    await post(s.base, ALICE, { principalId: "Jordan@Acme.test", role: "org_admin", scopeId: "org:default-org" });
    await post(s.base, ALICE, { principalId: "jordan@acme.test", role: "org_admin", scopeId: "org:default-org" });
    assert.equal((await del(s.base, ALICE, "admin-alice", "org:default-org", "org_admin")).status, 200);
    const r = await del(s.base, "jordan@acme.test@default-org", "jordan@acme.test", "org:default-org", "org_admin");
    assert.equal(r.status, 400, "two case-variant rows are still one person — the lock-out guard holds");
    assert.deepEqual(await whoami(s.base, "jordan@acme.test@default-org"), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await s.close();
  }
});

test("canAdminister agrees with adminStatusOf: a cased grant admits the canonical actor", async () => {
  const { createAdminService } = await import("../src/admin/admin-service.ts");
  const svc = createAdminService();
  await svc.createGrant(
    { id: "admin-alice", type: "internal" },
    { principalId: "Jordan@Acme.test", role: "org_admin", scopeId: "org:default-org" },
  );
  assert.equal(await svc.canAdminister({ id: "jordan@acme.test", type: "internal" }, "org:default-org"), true);
  assert.equal(await svc.canAdminister({ id: "casey@acme.test", type: "internal" }, "org:default-org"), false);
});

test("a non-admin cannot revoke (403)", async () => {
  const s = start();
  try {
    const r = await del(s.base, NOBODY, "admin-bob", "org:default-org", "org_admin");
    assert.equal(r.status, 403);
    assert.deepEqual(await whoami(s.base, BOB), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await s.close();
  }
});

test("the last org admin cannot be revoked (400 lock-out guard)", async () => {
  const s = start();
  try {
    assert.equal((await del(s.base, ALICE, "admin-bob", "org:default-org", "org_admin")).status, 200);
    const r = await del(s.base, ALICE, "admin-alice", "org:default-org", "org_admin");
    assert.equal(r.status, 400);
    assert.deepEqual(await whoami(s.base, ALICE), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await s.close();
  }
});

test("without DATABASE_URL grants are in-memory: the seed re-applies each boot; a runtime promotion is NOT durable", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "admin-grants-mem-"));
  const boot = () => {
    const built = buildApp(testConfig({ dataDir }));
    const server = createInsecureTestServer(built.app, {
      admin: built.admin,
      sessions: built.sessions,
      auditLog: built.auditLog,
    });
    server.listen(0);
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
  };
  const b1 = boot();
  try {
    assert.equal(
      (await post(b1.base, ALICE, { principalId: "U-durable", role: "org_admin", scopeId: "org:default-org" })).status,
      200,
    );
    assert.deepEqual(await whoami(b1.base, "U-durable@default-org"), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await b1.close();
  }
  const b2 = boot();
  try {
    assert.deepEqual(await whoami(b2.base, "U-durable@default-org"), { isAdmin: false, permissions: [] });
    assert.deepEqual(await whoami(b2.base, ALICE), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await b2.close();
  }
});

test("boot seed: durable mode never seeds the fictional admin-alice/admin-bob defaults", async () => {
  const { bootAdminGrantSeed } = await import("../src/admin/admin-service.ts");
  assert.deepEqual(bootAdminGrantSeed(undefined, "acme", true), [], "durable + no ADMIN_GRANTS → no fictional admins");
  assert.deepEqual(
    bootAdminGrantSeed(undefined, "acme", false).map((g) => g.principalId),
    ["admin-alice", "admin-bob"],
    "memory mode keeps the dev/test convenience defaults",
  );
  assert.deepEqual(
    bootAdminGrantSeed("alice:org_admin", "acme", true).map((g) => g.principalId),
    ["alice"],
    "ADMIN_GRANTS names the real admins in either mode",
  );
  assert.deepEqual(
    bootAdminGrantSeed("slack:U123:org_admin", "acme", true).map((g) => g.principalId),
    ["slack:U123"],
    "principal ids may contain colons",
  );
});
