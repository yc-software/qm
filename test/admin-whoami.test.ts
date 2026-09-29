import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { testConfig } from "./support/test-config.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { scopeId } from "../src/types.ts";

function start(withAdmin = true, signingSecret?: string) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-whoami-")) }));
  const deps = {
    ...(withAdmin ? { admin: built.admin } : {}),
    auditLog: built.auditLog,
  };
  const server = signingSecret
    ? createServer(built.app, { ...deps, signingSecret })
    : createInsecureTestServer(built.app, deps);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
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
  const svc = createAdminService();
  const alice = svc.resolveActor("admin-alice@default-org")!;
  assert.deepEqual(await svc.adminStatusOf(alice), { isAdmin: true, role: "org_admin", scopeId: "org:default-org" });
  const nobody = svc.resolveActor("U-nobody@default-org")!;
  assert.deepEqual(await svc.adminStatusOf(nobody), { isAdmin: false });
});

test("signed portal whoami preserves session-cap actor, grant and active-principal decisions", async () => {
  const source = "whoami-source-only-secret-0123456789";
  const portal = "whoami-portal-only-secret-0123456789";
  const capability = "whoami-capability-only-secret-0123456789";
  const built = buildApp(testConfig());
  const server = createServer(built.app, {
    signingSecret: source,
    portalIdentitySecret: portal,
    capabilitySecret: capability,
    requireSignedPortalIdentity: true,
    identity: built.identity,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (method: "GET" | "POST", path: string, token?: string) => {
    const signedPath = withSourceAuthNonce(path, source);
    return fetch(base + signedPath, {
      method,
      headers: {
        ...signedHeaders(source, method, signedPath),
        ...(token ? { "x-portal-identity": token } : {}),
        "x-admin-actor": "admin-bob@default-org",
      },
    });
  };
  const viaCapability = async (token?: string) => {
    const minted = await request("POST", "/v1/session-cap", token);
    if (minted.status !== 200) return minted;
    const { token: cap } = (await minted.json()) as { token: string };
    return fetch(base + "/v1/admin/whoami", { headers: { "x-agent-capability": cap } });
  };
  const compare = async (token: string | undefined, status: number, permissions: string[]) => {
    const responses = await Promise.all([request("GET", "/v1/admin/whoami", token), viaCapability(token)]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(
      responses.map((response) => response.status),
      [status, status],
    );
    assert.deepEqual(bodies[0], bodies[1]);
    if (status === 200) assert.deepEqual((bodies[0] as { permissions: string[] }).permissions, permissions);
  };
  try {
    const admin = await mintPortalIdentity({ p: "admin-alice", exp: Date.now() + 60000 }, portal);
    await compare(admin, 200, ["admin"]);
    await compare(
      await mintPortalIdentity({ p: "ordinary@example.invalid", exp: Date.now() + 60000 }, portal),
      200,
      [],
    );
    await compare(
      await mintPortalIdentity(
        { p: "ordinary@example.invalid", imp: "admin-alice", authenticatedAs: "admin-alice", exp: Date.now() + 60000 },
        portal,
      ),
      200,
      [],
    );
    await compare(
      await mintPortalIdentity({ p: "admin-alice", authenticatedAs: "unrelated", exp: Date.now() + 60000 }, portal),
      401,
      [],
    );
    await compare(await mintPortalIdentity({ p: "admin-alice", exp: Date.now() - 1 }, portal), 401, []);
    await compare(await mintPortalIdentity({ p: "admin-alice", exp: Date.now() + 60000 }, source), 401, []);
    await compare(undefined, 401, []);

    const minted = await request("POST", "/v1/session-cap", admin);
    const { token: retainedCapability } = (await minted.json()) as { token: string };
    await built.admin.revokeGrant(
      { id: "admin-bob", type: "internal" },
      "admin-alice",
      scopeId("org", "default-org"),
      "org_admin",
    );
    await compare(admin, 200, []);
    const retained = await fetch(base + "/v1/admin/whoami", { headers: { "x-agent-capability": retainedCapability } });
    assert.deepEqual(await retained.json(), { isAdmin: false, permissions: [] });
    await built.identity.deactivate("admin-alice");
    await compare(admin, 401, []);
    assert.equal(
      (await fetch(base + "/v1/admin/whoami", { headers: { "x-agent-capability": retainedCapability } })).status,
      401,
    );
    await compare(
      await mintPortalIdentity(
        { p: "ordinary@example.invalid", imp: "admin-alice", authenticatedAs: "admin-alice", exp: Date.now() + 60000 },
        portal,
      ),
      401,
      [],
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
