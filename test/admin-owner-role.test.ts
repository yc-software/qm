import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { liveRunClaims, liveRunStore } from "./support/live-run.ts";
import { bill } from "./support/spend-usage.ts";
import { testConfig } from "./support/test-config.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "./support/test-database.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

const SECRET = "owner-role-test-secret".repeat(3);
const ORG = "org:default-org";
const ADMIN_ACTOR = "admin-alice@default-org";
const OWNER_ACTOR = "owner-pat@default-org";

async function start(overrides: Record<string, unknown> = {}) {
  const clock = { at: Date.UTC(2026, 0, 5, 12) };
  const sessions = createPostgresSessionStore(testDatabaseUrl(), { now: () => clock.at });
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "admin-owner-")),
      adminGrants: "admin-alice:org_admin,owner-pat:owner",
      capabilitySecret: SECRET,
      ...overrides,
    }),
  );
  const keychain = createKeychain({
    lock: testAdvisoryLock(),
    creds: testMap(),
    grants: testMap(),
    asks: testMap(),
    key: deriveConnectorKey("admin-owner-keychain"),
  });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    config: built.config,
    memory: built.memory,
    sessions,
    runs: liveRunStore(built.runs),
    errors: built.errors,
    keychain,
    identity: built.identity,
    principalLinks: built.principalLinks,
    replayDedupe: built.replayDedupe,
    capabilitySecret: SECRET,
    portalUrl: "https://portal.example",
    portalIdentitySecret: SECRET,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, sessions, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const req = (base: string, method: string, path: string, actor: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "x-admin-actor": actor,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

test("owner whoami, org management, private-read denial, and privilege-escalation refusal", async () => {
  const s = await start();
  try {
    const who = await req(s.base, "GET", "/v1/admin/whoami", OWNER_ACTOR);
    assert.equal(who.status, 200);
    assert.deepEqual(await who.json(), {
      isAdmin: true,
      role: "owner",
      scopeId: ORG,
      permissions: ["owner"],
    });

    await bill(s.sessions, "dm:bob:secret", "dm", scopeId("personal", "bob"), { costUsd: 1 });

    for (const [method, path, body] of [
      ["GET", `/v1/admin/scopes/${encodeURIComponent(ORG)}`, undefined],
      ["PUT", `/v1/admin/scopes/${encodeURIComponent(ORG)}/soul`, { content: "Be concise." }],
      ["POST", `/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, { facts: ["Org fact"] }],
      ["GET", `/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, undefined],
      ["GET", "/v1/admin/users", undefined],
      ["GET", "/v1/admin/spend", undefined],
      ["GET", "/v1/admin/resources", undefined],
      ["GET", "/v1/admin/retention", undefined],
      ["POST", "/v1/admin/grants", { principalId: "co-owner", role: "owner", scopeId: ORG }],
      ["DELETE", `/v1/admin/grants/co-owner?scope=${encodeURIComponent(ORG)}&role=owner`, undefined],
    ] as const) {
      const r = await req(s.base, method, path, OWNER_ACTOR, body);
      assert.equal(r.status, 200, `owner allowed ${method} ${path}: ${await r.text()}`);
    }

    const deniedPaths: Array<[string, string, unknown?]> = [
      ["GET", "/v1/admin/sessions?scope=personal:bob"],
      ["GET", "/v1/admin/sessions/dm%3Abob%3Asecret?scope=personal:bob"],
      ["GET", "/v1/admin/sessions/dm%3Abob%3Asecret/llm?scope=personal:bob"],
      ["GET", "/v1/admin/scopes"],
      ["GET", "/v1/admin/scopes/personal:bob"],
      ["PUT", "/v1/admin/scopes/personal:bob/soul", { content: "nope" }],
      ["GET", "/v1/admin/memory?scope=personal:bob"],
      ["POST", "/v1/admin/memory?scope=personal:bob", { facts: ["nope"] }],
      ["GET", "/v1/admin/memory/scopes"],
      ["GET", "/v1/admin/memory-registry"],
      ["GET", "/v1/admin/files?scope=personal:bob"],
      ["GET", "/v1/admin/crons?scope=personal:bob"],
      ["GET", "/v1/admin/apps?scope=personal:bob"],
      ["GET", "/v1/admin/skills?scope=personal:bob"],
      ["GET", "/v1/admin/skill-packs"],
      ["GET", "/v1/admin/errors?scope=personal:bob"],
      ["GET", "/v1/admin/audit?scope=personal:bob"],
      ["GET", "/v1/admin/egress?scope=personal:bob"],
      ["GET", "/v1/admin/keychain"],
      ["GET", "/v1/admin/users/bob"],
      ["POST", "/v1/admin/users/bob/offboard", {}],
      ["POST", "/v1/admin/users/bob/reset", {}],
      ["POST", "/v1/admin/users/bob/reactivate", {}],
      ["PUT", "/v1/admin/users/bob/onboarding", { state: "done" }],
      ["GET", "/v1/admin/slack-mirror?scope=org:default-org"],
      ["GET", "/v1/admin/ambient-judgments?scope=org:default-org"],
      ["GET", "/v1/admin/ack-emoji-picks?scope=org:default-org"],
      ["GET", "/v1/admin/security/flags"],
      ["GET", "/v1/admin/sandboxes/personal:bob"],
      ["GET", "/v1/admin/principal-links"],
      ["POST", "/v1/admin/impersonate", { target: "bob" }],
      ["POST", "/v1/admin/grants", { principalId: "owner-pat", role: "org_admin", scopeId: ORG }],
      ["DELETE", `/v1/admin/grants/admin-alice?scope=${encodeURIComponent(ORG)}&role=org_admin`],
      [
        "POST",
        "/v1/admin/external-users",
        { email: "ext@partner.example", role: "org_admin", expiresAt: Date.now() + 86_400_000 },
      ],
    ];
    for (const [method, path, body] of deniedPaths) {
      const r = await req(s.base, method, path, OWNER_ACTOR, body);
      assert.equal(r.status, 403, `owner denied ${method} ${path}`);
    }

    for (const path of [
      "/v1/admin/sessions?scope=personal:bob",
      "/v1/admin/scopes",
      "/v1/admin/keychain",
      "/v1/admin/users/bob",
    ]) {
      const r = await req(s.base, "GET", path, ADMIN_ACTOR);
      assert.equal(r.status, 200, `org_admin keeps ${path}`);
    }
  } finally {
    await s.close();
  }
});

test("spend redacts other people's personal cron details for owner while keeping own crons and totals", async () => {
  const s = await start();
  try {
    const bobCron = await s.built.app.createCron({
      ownerScopeId: "personal:bob",
      owner: "bob",
      createdBy: "bob",
      schedule: { everyMs: 3_600_000 },
      title: "Bob secret digest",
      action: "private bob prompt",
    });
    const patCron = await s.built.app.createCron({
      ownerScopeId: "personal:owner-pat",
      owner: "owner-pat",
      createdBy: "owner-pat",
      schedule: { everyMs: 3_600_000 },
      title: "Pat own digest",
      action: "pat own prompt",
    });
    await bill(s.sessions, `cron:${bobCron.id}:fire:1`, "dm", scopeId("personal", "bob"), { costUsd: 2 });
    await bill(s.sessions, `cron:${patCron.id}:fire:1`, "dm", scopeId("personal", "owner-pat"), { costUsd: 2 });
    const query = "from=2026-01-05&to=2026-01-06";
    const ownerSpend: any = await (await req(s.base, "GET", `/v1/admin/spend?${query}`, OWNER_ACTOR)).json();
    const byId = new Map(ownerSpend.crons.map((c: any) => [c.cronId, c]));
    assert.equal(ownerSpend.org.costUsd, 4);
    assert.equal((byId.get(bobCron.id) as any).info, null);
    assert.equal((byId.get(patCron.id) as any).info.action, "pat own prompt");

    const ownerCsv = await (
      await req(s.base, "GET", `/v1/admin/spend?${query}&format=csv&breakdown=cron`, OWNER_ACTOR)
    ).text();
    assert.ok(!ownerCsv.includes("Bob secret digest"));
    assert.ok(ownerCsv.includes("Pat own digest"));

    const adminSpend: any = await (await req(s.base, "GET", `/v1/admin/spend?${query}`, ADMIN_ACTOR)).json();
    assert.equal(adminSpend.crons.find((c: any) => c.cronId === bobCron.id).info.action, "private bob prompt");
  } finally {
    await s.close();
  }
});

test("owner agent capability exposes owner self-API catalog and enforces owner route bounds", async () => {
  const s = await start();
  try {
    const token = await mintCapabilityToken(
      {
        actorId: "owner-pat",
        aud: CONTROL_PLANE_AUD,
        scopeId: scopeId("personal", "owner-pat"),
        exp: Date.now() + 60_000,
        ...liveRunClaims("owner-pat"),
      },
      SECRET,
    );
    const headers = { "x-agent-capability": token };
    const apisText = await (await fetch(`${s.base}/v1/apis`, { headers })).text();
    assert.match(apisText, /Admin plane \(org owner\)/);
    assert.ok(!apisText.includes("/v1/admin/sessions"));
    assert.ok(!apisText.includes("/v1/admin/keychain"));
    assert.equal((await fetch(`${s.base}/v1/admin/users`, { headers })).status, 200);
    assert.equal((await fetch(`${s.base}/v1/admin/sessions?scope=personal:bob`, { headers })).status, 403);
    assert.equal((await fetch(`${s.base}/v1/admin/memory?scope=personal:bob`, { headers })).status, 403);
  } finally {
    await s.close();
  }
});

test("trustedOidcAdminRole=owner provisions trusted-entry and self-serve users as owner", async () => {
  const s = await start({
    trustedOidcAdminIssuer: "https://auth.example",
    trustedOidcAdminRole: "owner",
  });
  try {
    const a = await s.built.admin.provisionTrustedEntry(tenant, "https://auth.example", "user-a");
    const b = await s.built.admin.provisionSelfServe(tenant, "https://auth.example", "user-b", "user-b@example.com");
    assert.equal(a.grant.role, "owner");
    assert.equal(b.grant.role, "owner");
    const status = await s.built.admin.adminStatusOf(tenant, { id: a.grant.principalId, type: "internal" });
    assert.equal(status.role, "owner");
    assert.equal(status.isAdmin, true);
  } finally {
    await s.close();
  }
});
