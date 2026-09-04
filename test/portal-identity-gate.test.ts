import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";
import { isUnclassifiedWrite } from "../src/api/user-scoped-routes.ts";
import { authBrokerRoutes } from "../src/api/routes/auth-broker.ts";

const SOURCE = "shared-source-auth-secret-for-tests-0001";
const CAP = "core-only-capability-secret-for-tests-01";
const PID = "portal-only-identity-secret-for-tests-01";

describe("user-scoped routes require a portal-verified actor when enforcement is on", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const token = async (p: string, secret = PID) => mintSignedPayload({ p, exp: Date.now() + 60_000 }, secret);

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "pid-gate-")) }));
    server = createInsecureTestServer(built.app, {
      capabilitySecret: CAP,
      portalIdentitySecret: PID,
      requireSignedPortalIdentity: true,
      scheduler: built.scheduler,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = (headers: Record<string, string> = {}) => fetch(`${base}/v1/sessions/nope?viewer=U1`, { headers });

  it("passes the gate when a valid portal identity matches the requested viewer", async () => {
    assert.equal((await get({ "x-portal-identity": await token("U1") })).status, 404);
  });

  it("rejects (401) when no portal identity is forwarded", async () => {
    assert.equal((await get()).status, 401);
  });

  it("rejects (403) when the portal identity names a different user than the viewer", async () => {
    assert.equal((await get({ "x-portal-identity": await token("U2") })).status, 403);
  });

  it("rejects (401) a portal identity forged with the source-auth secret (what a surface holds)", async () => {
    assert.equal((await get({ "x-portal-identity": await token("U1", SOURCE) })).status, 401);
  });

  it("production implies signed identity on the raw deployment proxy", async () => {
    const prodServer = createInsecureTestServer(built.app, { production: true, portalIdentitySecret: PID });
    await new Promise<void>((resolve) => prodServer.listen(0, resolve));
    try {
      const prodBase = `http://localhost:${(prodServer.address() as AddressInfo).port}`;
      assert.equal((await fetch(`${prodBase}/d/missing/`)).status, 403);
    } finally {
      await new Promise<void>((resolve) => prodServer.close(() => resolve()));
    }
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("per-user reads bind their caller-named identity field to the portal actor", async () => {
    const alice = await token("U1");
    for (const path of [
      "/v1/memory/history?principalId=",
      "/v1/contexts/policy?scope=channel:C1&principalId=",
      "/v1/sessions/s1/background?viewer=",
      "/v1/sessions/s1/background/p1/output?viewer=",
    ]) {
      assert.equal((await fetch(`${base}${path}U1`)).status, 401, `${path} without an identity`);
      assert.equal(
        (await fetch(`${base}${path}U2`, { headers: { "x-portal-identity": alice } })).status,
        403,
        `${path} naming another principal`,
      );
      const mine = await fetch(`${base}${path}U1`, { headers: { "x-portal-identity": alice } });
      assert.ok(mine.status !== 401 && mine.status !== 403, `${path} as myself should reach the handler`);
    }
  });

  it("memory restore binds its body principalId to the portal actor", async () => {
    assert.equal(
      (await post("/v1/memory/restore", { principalId: "U2", revision: "r1", expectedRevision: "r0" })).status,
      401,
    );
    const r = await post(
      "/v1/memory/restore",
      { principalId: "U2", revision: "r1", expectedRevision: "r0" },
      { "x-portal-identity": await token("U1") },
    );
    assert.equal(r.status, 403, "restoring another person's memory must not pass on a bare valid actor");
  });

  it("directory resolve requires a portal actor even though it names no identity field", async () => {
    assert.equal((await fetch(`${base}/v1/directory/resolve?q=alice`)).status, 401);
    const r = await fetch(`${base}/v1/directory/resolve?q=alice`, {
      headers: { "x-portal-identity": await token("U1") },
    });
    assert.ok(r.status !== 401, "a verified actor may resolve names");
  });

  it("a user-scoped write (skills) rejects a body principalId that doesn't match the portal identity", async () => {
    const r = await post(
      "/v1/skills",
      { principalId: "U2", name: "x", body: "y" },
      { "x-portal-identity": await token("U1") },
    );
    assert.equal(r.status, 403);
  });

  it("Project reads and every mutation bind principalId to the portal identity", async () => {
    assert.equal((await fetch(`${base}/v1/projects?principalId=U1`)).status, 401);
    assert.equal(
      (await fetch(`${base}/v1/projects?principalId=U2`, { headers: { "x-portal-identity": await token("U1") } }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/v1/projects?principalId=U1`, { headers: { "x-portal-identity": await token("U1") } }))
        .status,
      200,
    );

    for (const [method, path, body] of [
      ["POST", "/v1/projects", { principalId: "U2", name: "forged" }],
      ["POST", "/v1/projects/p1/members", { principalId: "U2", memberId: "U3" }],
      ["DELETE", "/v1/projects/p1/members/U3", { principalId: "U2" }],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-portal-identity": await token("U1") },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  });

  it("direct cron reads and mutations require the portal actor as principalId", async () => {
    const cron = await built.app.createCron({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "private task",
    });
    const path = `/v1/crons/${encodeURIComponent(cron.id)}`;
    const alice = await token("U1");
    for (const [method, suffix] of [
      ["GET", ""],
      ["PATCH", ""],
      ["DELETE", ""],
    ] as const) {
      const init = {
        method,
        headers: { "content-type": "application/json", "x-portal-identity": alice },
        ...(method === "PATCH" ? { body: JSON.stringify({ title: "changed" }) } : {}),
      };
      assert.equal((await fetch(`${base}${path}${suffix}`, init)).status, 403, `${method} without principalId`);
      assert.equal(
        (await fetch(`${base}${path}?principalId=U2`, init)).status,
        403,
        `${method} with another principalId`,
      );
    }
    assert.equal(
      (await fetch(`${base}${path}?principalId=U1`, { headers: { "x-portal-identity": alice } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}${path}?principalId=U1`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-portal-identity": alice },
          body: JSON.stringify({ schedule: { everyMs: 1 } }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}${path}?principalId=U1`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-portal-identity": alice },
          body: JSON.stringify({ title: "mine" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}${path}?principalId=U1`, { method: "DELETE", headers: { "x-portal-identity": alice } }))
        .status,
      200,
    );
  });

  it("binds webhook, deployment, and approval routes to the verified actor", async () => {
    const alice = await token("U1");
    const aliceHeaders = { "content-type": "application/json", "x-portal-identity": alice };
    const webhook = await built.app.createWebhook({
      ownerScopeId: "personal:U2",
      owner: "U2",
      createdBy: "U2",
      action: "private webhook",
      verification: { scheme: "hmac-sha256", secret: "webhook-secret" },
    });
    assert.equal((await fetch(`${base}/v1/webhooks?viewer=U2`, { headers: aliceHeaders })).status, 403);
    assert.deepEqual(
      (
        (await (await fetch(`${base}/v1/webhooks?viewer=U1`, { headers: aliceHeaders })).json()) as {
          webhooks: unknown[];
        }
      ).webhooks,
      [],
    );
    assert.equal(
      (
        await fetch(`${base}/v1/webhooks/${webhook.id}/disable?principalId=U1`, {
          method: "POST",
          headers: aliceHeaders,
        })
      ).status,
      403,
    );

    const deployment = {
      id: "deployment-u2",
      ownerScopeId: scopeId("personal", "U2"),
      createdBy: "U2",
      currentVersion: 1,
      status: "running" as const,
      endpoint: null,
      versions: [{ version: 1, createdAt: Date.now(), entrypoint: "node app.js", snapshotDir: "" }],
    };
    built.app.listDeployments = async () => [deployment];
    built.app.listDeploymentsForViewer = async () => [];
    built.app.canManageDeployment = async (_id, principalId) => principalId === "U2";
    assert.equal((await fetch(`${base}/v1/deployments?principalId=U2`, { headers: aliceHeaders })).status, 403);
    for (const [suffix, body] of [
      ["name", { name: "stolen" }],
      ["display-name", { displayName: "Stolen" }],
      ["archive", {}],
      ["rollback", { version: 1 }],
      ["redeploy", { entrypoint: "node app.js", files: [] }],
    ] as const) {
      const response = await fetch(`${base}/v1/deployments/${deployment.id}/${suffix}`, {
        method: "POST",
        headers: aliceHeaders,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403, `deployment ${suffix}`);
    }

    built.config.setCommandPolicy(scopeId("org", "default-org"), {
      mode: "denylist",
      rules: [{ pattern: "printf", decision: "require_approval" }],
    });
    const pending = await built.app.turn({
      surface: "web",
      actor: { externalId: "U2" },
      conversation: { kind: "dm", threadRef: "web:U2:private" },
      text: "!run printf private",
    });
    assert.equal(pending.status, "pending_approval");
    const requestId = pending.pendingApprovals![0]!.requestId;
    assert.equal((await fetch(`${base}/v1/approvals/${requestId}`, { headers: aliceHeaders })).status, 404);
    const pendingBody = (await (
      await fetch(`${base}/v1/approvals/pending?threadRef=${encodeURIComponent("web:U2:private")}`, {
        headers: aliceHeaders,
      })
    ).json()) as { pending: unknown };
    assert.equal(pendingBody.pending, null);
  });

  it("a web turn whose body actor doesn't match the portal identity is rejected", async () => {
    const r = await post(
      "/v1/turns",
      { surface: "web", text: "hi", actor: { externalId: "U2" }, conversation: { kind: "dm", threadRef: "t" } },
      { "x-portal-identity": await token("U1") },
    );
    assert.equal(r.status, 403);
  });

  it("a slack turn carries no portal identity and is not gated (different trust authority)", async () => {
    const r = await post("/v1/turns", {
      surface: "slack",
      text: "hi",
      actor: { externalId: "U9" },
      conversation: { kind: "dm", threadRef: "t" },
    });
    assert.notEqual(r.status, 401);
    assert.notEqual(r.status, 403);
  });

  it("an admin route with no portal identity is rejected (x-admin-actor alone no longer suffices)", async () => {
    assert.equal(
      (await fetch(`${base}/v1/admin/whoami`, { headers: { "x-admin-actor": "U1@default-org" } })).status,
      401,
    );
  });

  it("POST /v1/session-cap mints a REAL capability token for the portal-verified user", async () => {
    const r = await post("/v1/session-cap", {}, { "x-portal-identity": await token("U1") });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { token: unknown };
    assert.equal(typeof body.token, "string", "token must be the minted string, not a serialized Promise");
    assert.ok((body.token as string).length > 0);
    const claims = await verifyCapabilityToken(body.token as string, CAP);
    assert.equal(claims?.actorId, "U1");
    assert.equal(claims?.scopeId, "personal:U1");
  });
});

describe("service-to-service writes are classified", () => {
  it("every auth:source write route is classified, so production gating cannot demand a portal identity from a plugin", () => {
    const unclassified = authBrokerRoutes
      .filter((route) => "path" in route && route.auth === "source")
      .map((route) => route as { method: string; path: string })
      .filter((route) => isUnclassifiedWrite(route.method, route.path))
      .map((route) => `${route.method} ${route.path}`);
    assert.deepEqual(
      unclassified,
      [],
      "an unclassified write requires a portal identity under REQUIRE_SIGNED_PORTAL_IDENTITY; add it to SYSTEM in user-scoped-routes.ts",
    );
  });
});
