import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { agentApiMatches } from "../src/api/agent-api-catalog.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "discovery-test-secret".repeat(3);
const ORG = scopeId("org", "default-org");

async function start() {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "agent-apis-")),
      signingSecret: SECRET,
    }),
  );
  const server = createServer(built.app, {
    admin: built.admin,
    memory: built.memory,
    auditLog: built.auditLog,
    signingSecret: SECRET,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const capFor = (
  actorId: string,
  opts: {
    memory?: { write?: ScopeId; orgWrite?: ScopeId; read: ScopeId[] };
    liveActor?: boolean;
    grants?: string[];
  } = {},
) =>
  mintCapabilityToken(
    {
      actorId,
      scopeId: scopeId("personal", actorId),
      exp: Date.now() + CAPABILITY_TTL_MS,
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.liveActor ? { liveActor: true } : {}),
      ...(opts.grants ? { grants: opts.grants } : {}),
    },
    SECRET,
  );

const listApis = async (base: string, cap: string) => {
  const res = await fetch(`${base}/v1/apis`, { headers: { "x-agent-capability": cap } });
  return { status: res.status, body: (await res.json()) as any };
};
const paths = (body: any): string[] => body.endpoints.map((e: any) => e.path);

test("discovery for a regular user: base surface + whoami, no admin rows, no memory rows without claims", async () => {
  const s = await start();
  try {
    const { status, body } = await listApis(s.base, await capFor("U1"));
    assert.equal(status, 200);
    assert.deepEqual(body.admin, { isAdmin: false });
    const p = paths(body);
    assert.ok(p.includes("/v1/apis"));
    assert.ok(!p.includes("/v1/crons"), "cron is a typed tool now, not a discovery row");
    assert.ok(!p.includes("/v1/webhooks"), "webhook is a typed tool now, not a discovery row");
    assert.ok(!p.includes("/v1/soul"), "soul is a typed tool now, not a discovery row");
    assert.ok(p.includes("/v1/skills"), "saving a personal skill is a discoverable self-API endpoint");
    assert.ok(p.includes("/v1/keychain/overview"), "the keychain overview gate is represented in discovery");
    assert.ok(p.includes("/v1/admin/whoami"), "everyone can ask whether the user is an admin");
    assert.ok(!p.includes("/v1/admin/scopes"), "admin rows must not render for a non-admin");
    assert.ok(!p.some((x: string) => x.startsWith("/v1/memory")), "no memory rows without memory claims");
    assert.doesNotMatch(JSON.stringify(body), /auto-grant/i);
    assert.match(
      body.endpoints.find((endpoint: any) => endpoint.path === "/v1/connectors/oauth/consent/mint")?.summary ?? "",
      /stays private.*explicit credential grant/i,
    );
  } finally {
    await s.close();
  }
});

test("discovery follows the token's memory claims, including the org selector", async () => {
  const s = await start();
  try {
    const U1 = scopeId("personal", "U1");
    const hasOrgSelector = (body: any) => body.endpoints.some((e: any) => e.summary.includes('"scope":"org"'));
    const plain = await listApis(s.base, await capFor("U1", { memory: { write: U1, read: [U1] } }));
    assert.ok(paths(plain.body).includes("/v1/memory/self"));
    assert.ok(!hasOrgSelector(plain.body), "no org selector without orgWrite");

    const org = await listApis(
      s.base,
      await capFor("admin-alice", {
        memory: { write: scopeId("personal", "admin-alice"), orgWrite: ORG, read: [ORG] },
      }),
    );
    assert.ok(hasOrgSelector(org.body), "orgWrite tokens see the org selector row");
  } finally {
    await s.close();
  }
});

test("discovery for an org admin's LIVE turn includes the admin plane (live grant check), with guidance", async () => {
  const s = await start();
  try {
    const { body } = await listApis(s.base, await capFor("admin-alice", { liveActor: true }));
    assert.deepEqual(body.admin, { isAdmin: true, role: "org_admin" });
    const p = paths(body);
    assert.ok(p.includes("/v1/admin/scopes"));
    assert.ok(p.includes("/v1/admin/users"));
    assert.ok(!p.includes("/v1/admin/grants"), "grant management is portal-only and must not be advertised");
    assert.ok(body.guidance.some((g: string) => g.includes("confirm before any mutation")));
    assert.equal(p.filter((x: string) => x === "/v1/admin/whoami").length, 1, "whoami listed once, not duplicated");
  } finally {
    await s.close();
  }
});

test("an admin's AUTONOMOUS turn (no liveActor) is shown no admin plane — matching what the gate enforces", async () => {
  const s = await start();
  try {
    const { body } = await listApis(s.base, await capFor("admin-alice"));
    assert.equal(body.admin.isAdmin, true, "status is still reported truthfully");
    const p = paths(body);
    assert.ok(!p.includes("/v1/admin/scopes"), "no admin rows without a live-actor token");
    assert.ok(p.includes("/v1/admin/whoami"), "introspection stays available");
  } finally {
    await s.close();
  }
});

test("a granted autonomous turn discovers only the unattended read family", async () => {
  const s = await start();
  try {
    const { body } = await listApis(s.base, await capFor("admin-alice", { grants: ["admin.sessions.read"] }));
    const adminPaths = paths(body).filter((path) => path.startsWith("/v1/admin/"));
    assert.deepEqual(adminPaths, [
      "/v1/admin/sessions",
      "/v1/admin/sessions/:id",
      "/v1/admin/scopes",
      "/v1/admin/errors",
      "/v1/admin/runs",
      "/v1/admin/whoami",
    ]);
    assert.ok(body.guidance.some((guidance: string) => guidance.includes("flag any other admin action")));
  } finally {
    await s.close();
  }
});

test("discovery requires a capability token", async () => {
  const s = await start();
  try {
    assert.equal((await fetch(`${s.base}/v1/apis`)).status, 401);
  } finally {
    await s.close();
  }
});

test("discovery advertises the deployment share endpoint, with guidance", async () => {
  const s = await start();
  try {
    const { body } = await listApis(s.base, await capFor("U1"));
    const p = paths(body);
    assert.ok(p.includes("/v1/deployments/:id/share"), "the share endpoint is discoverable");
    assert.ok(p.includes("/v1/deployments/:id/git-url"), "git-url stays discoverable");
    assert.ok(p.includes("/v1/deployments/:id"), "deployment detail is discoverable");
    assert.ok(p.includes("/v1/deployments/:id/restore"), "restore is discoverable");
    assert.ok(
      body.guidance.some((g: string) => /share it with everyone/i.test(g)),
      "share guidance is present",
    );
  } finally {
    await s.close();
  }
});

test("the catalog IS the gate: discovery rows with real paths are admitted, unlisted routes are not", () => {
  assert.equal(agentApiMatches("GET", "/v1/apis"), true);
  assert.equal(agentApiMatches("POST", "/v1/deployments/abc/share"), true);
  assert.equal(agentApiMatches("GET", "/v1/deployments/abc"), true);
  assert.equal(agentApiMatches("POST", "/v1/deployments/abc/restore"), true);
  assert.equal(agentApiMatches("GET", "/v1/deployments/abc/share"), false, "share is POST-only");
  assert.equal(agentApiMatches("POST", "/v1/share"), true, "the uniform share verb is agent-callable");
  assert.equal(agentApiMatches("GET", "/v1/share"), false, "share is POST-only");
  assert.equal(agentApiMatches("POST", "/v1/crons"), true);
  assert.equal(agentApiMatches("POST", "/v1/skills"), true);
  assert.equal(agentApiMatches("PUT", "/v1/skills/abc"), true);
  assert.equal(agentApiMatches("DELETE", "/v1/skills/abc"), true);
  assert.equal(agentApiMatches("GET", "/v1/skills/abc"), true);
  assert.equal(agentApiMatches("POST", "/v1/skills/abc/restore"), true);
  assert.equal(agentApiMatches("GET", "/v1/crons/abc"), true);
  assert.equal(agentApiMatches("POST", "/v1/webhooks/abc/enable"), true);
  assert.equal(agentApiMatches("PUT", "/v1/memory/self"), true);
  assert.equal(agentApiMatches("PUT", "/v1/admin/memory"), true);
  assert.equal(agentApiMatches("GET", "/v1/admin/whoami"), true);
  assert.equal(
    agentApiMatches("POST", "/v1/connectors/oauth/revoke"),
    true,
    "disconnect is the mirror of connect — agent-callable",
  );
  assert.equal(agentApiMatches("POST", "/v1/turns"), false, "turn ingress stays source-auth only");
  assert.equal(agentApiMatches("GET", "/v1/sessions/abc"), false);
  assert.equal(agentApiMatches("DELETE", "/v1/webhooks"), false);
});
