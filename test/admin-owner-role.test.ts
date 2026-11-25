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
import { memberBrainId, putMemberBrain } from "../src/memory/registry.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId, personalScope } from "../src/types.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";
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
    memoryRegistry: built.memoryRegistry,
    secretDrops: built.secretDrops,
    brokerSessions: built.brokerSessions,
    sessions,
    runs: liveRunStore(built.runs),
    errors: built.errors,
    keychain,
    identity: built.identity,
    principalLinks: built.principalLinks,
    replayDedupe: built.replayDedupe,
    capabilitySecret: SECRET,
    ...browserSessionDeps,
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
      ["POST", "/v1/admin/users/bob/reset", {}],
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
      ownerScopeId: personalScope("bob"),
      owner: "bob",
      createdBy: "bob",
      schedule: { everyMs: 3_600_000 },
      title: "Bob secret digest",
      action: "private bob prompt",
    });
    const patCron = await s.built.app.createCron({
      ownerScopeId: personalScope("owner-pat"),
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
    assert.ok(apisText.includes("/v1/admin/memory-registry"));
    assert.ok(!apisText.includes("/v1/admin/sessions"));
    assert.ok(!apisText.includes("/v1/admin/keychain"));
    assert.equal((await fetch(`${s.base}/v1/admin/users`, { headers })).status, 200);
    assert.equal((await fetch(`${s.base}/v1/admin/sessions?scope=personal:bob`, { headers })).status, 403);
    assert.equal((await fetch(`${s.base}/v1/admin/memory?scope=personal:bob`, { headers })).status, 403);
  } finally {
    await s.close();
  }
});

test("owner manages org memory registry config while member-owned brains stay org_admin-only", async () => {
  const s = await start();
  try {
    const bobId = memberBrainId("bob");
    await s.built.memoryRegistry.update((record) =>
      putMemberBrain(
        record,
        "bob",
        { url: "https://bob.private.example/mcp", clientId: "bob-client", label: "Bob private brain" },
        {
          actor: "bob",
          now: Date.now(),
          overlayIds: s.built.memoryRegistry.overlayIds,
          key: s.built.memoryRegistry.key,
        },
      ),
    );
    await s.built.directory.replaceChannels(
      [{ channelId: "C1", name: "general", isPrivate: false }],
      [{ channelId: "C1", principalId: "owner-pat" }],
    );

    const orgBrain = {
      preset: "gbrain-v1",
      url: "https://brain.org.example/mcp",
      clientId: "org-qm",
      label: "Org memory",
    };
    const putBrainRes = await req(s.base, "PUT", "/v1/admin/memory-registry/brains/org-brain", OWNER_ACTOR, orgBrain);
    assert.equal(putBrainRes.status, 200);
    const putBrainText = await putBrainRes.text();
    assert.doesNotMatch(putBrainText, /bob\.private\.example|bob-client|Bob private brain/);

    const putBindRes = await req(s.base, "PUT", "/v1/admin/memory-registry/bindings/org-all", OWNER_ACTOR, {
      brain: "org-brain",
      scope: "personal",
    });
    assert.equal(putBindRes.status, 200);

    const toggleOff = await req(s.base, "PUT", "/v1/admin/memory-registry/member-brains", OWNER_ACTOR, {
      enabled: false,
    });
    assert.equal(toggleOff.status, 200);
    const toggleJson: any = await toggleOff.json();
    assert.equal(toggleJson.memberBrains, false);
    assert.deepEqual(
      toggleJson.brains.map((b: any) => b.id),
      ["org-brain"],
    );
    assert.deepEqual(
      toggleJson.bindings.map((b: any) => b.id),
      ["org-all"],
    );
    assert.ok(toggleJson.disabled.every((d: any) => d.provider !== bobId));

    const ownerView: any = await (await req(s.base, "GET", "/v1/admin/memory-registry", OWNER_ACTOR)).json();
    assert.deepEqual(
      ownerView.brains.map((b: any) => b.id),
      ["org-brain"],
    );
    assert.equal((await req(s.base, "GET", "/v1/admin/memory-registry/brains/org-brain", OWNER_ACTOR)).status, 200);
    assert.equal((await req(s.base, "GET", "/v1/admin/memory-registry/bindings/org-all", OWNER_ACTOR)).status, 200);
    assert.equal((await req(s.base, "GET", `/v1/admin/memory-registry/brains/${bobId}`, OWNER_ACTOR)).status, 404);
    assert.equal((await req(s.base, "GET", `/v1/admin/memory-registry/bindings/${bobId}`, OWNER_ACTOR)).status, 404);

    for (const [method, path, body] of [
      ["PUT", `/v1/admin/memory-registry/brains/${bobId}`, { label: "Nope" }],
      ["DELETE", `/v1/admin/memory-registry/brains/${bobId}`, undefined],
      ["PUT", `/v1/admin/memory-registry/bindings/${bobId}`, { label: "Nope" }],
      ["PUT", "/v1/admin/memory-registry/bindings/hijack", { brain: bobId, scope: personalScope("bob") }],
      ["DELETE", `/v1/admin/memory-registry/bindings/${bobId}`, undefined],
    ] as const) {
      assert.equal((await req(s.base, method, path, OWNER_ACTOR, body)).status, 403, `owner refused ${method} ${path}`);
    }

    const adminView: any = await (await req(s.base, "GET", "/v1/admin/memory-registry", ADMIN_ACTOR)).json();
    assert.deepEqual(adminView.brains.map((b: any) => b.id).sort(), [bobId, "org-brain"].sort());
    assert.equal((await req(s.base, "GET", `/v1/admin/memory-registry/brains/${bobId}`, ADMIN_ACTOR)).status, 200);

    const dmToken = await mintCapabilityToken(
      {
        actorId: "owner-pat",
        aud: CONTROL_PLANE_AUD,
        scopeId: scopeId("personal", "owner-pat"),
        exp: Date.now() + 60_000,
        ...liveRunClaims("owner-pat"),
      },
      SECRET,
    );
    const channelToken = await mintCapabilityToken(
      {
        actorId: "owner-pat",
        aud: CONTROL_PLANE_AUD,
        scopeId: scopeId("channel", "C1"),
        exp: Date.now() + 60_000,
        ...liveRunClaims("owner-pat"),
      },
      SECRET,
    );
    const agentCall = (token: string, method: string, path: string, body?: unknown) =>
      fetch(`${s.base}${path}`, {
        method,
        headers: {
          "x-agent-capability": token,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    assert.equal((await agentCall(channelToken, "GET", "/v1/admin/memory-registry")).status, 403);
    assert.equal((await agentCall(dmToken, "GET", "/v1/admin/memory-registry")).status, 200);
    assert.equal(
      (await agentCall(dmToken, "PUT", "/v1/admin/memory-registry/brains/org-brain", { label: "Org" })).status,
      200,
    );
    assert.equal((await agentCall(dmToken, "DELETE", "/v1/admin/memory-registry/bindings/org-all")).status, 403);
    assert.equal(
      (await agentCall(dmToken, "POST", "/v1/keychain/drops", { memoryBrain: "org-brain", purpose: "connect" })).status,
      200,
    );
    assert.equal(
      (await agentCall(dmToken, "POST", "/v1/keychain/drops", { memoryBrain: bobId, purpose: "nope" })).status,
      403,
    );

    assert.equal((await req(s.base, "DELETE", "/v1/admin/memory-registry/bindings/org-all", OWNER_ACTOR)).status, 200);
    assert.equal((await req(s.base, "DELETE", "/v1/admin/memory-registry/brains/org-brain", OWNER_ACTOR)).status, 200);
    const afterDelete: any = await (await req(s.base, "GET", "/v1/admin/memory-registry", ADMIN_ACTOR)).json();
    assert.deepEqual(
      afterDelete.brains.map((b: any) => b.id),
      [bobId],
    );
  } finally {
    await s.close();
  }
});

test("owner offboards and reactivates members access-only while keeping org_admin, last-owner, and private content protected", async () => {
  const s = await start({ adminGrants: "admin-alice:org_admin,owner-pat:owner,owner-sam:owner" });
  try {
    await s.built.app.upsertDirectory([
      { principalId: "admin-alice", displayName: "Alice", type: "internal" },
      { principalId: "owner-pat", displayName: "Pat", type: "internal" },
      { principalId: "owner-sam", displayName: "Sam", type: "internal" },
      { principalId: "bob@example.com", displayName: "Bob", type: "internal" },
    ]);
    const bobCron = await s.built.app.createCron({
      ownerScopeId: personalScope("bob@example.com"),
      owner: "bob@example.com",
      createdBy: "bob@example.com",
      title: "Bob private digest",
      schedule: { everyMs: 3_600_000 },
      action: "private prompt",
    });
    await s.built.featureFlags.setEnabled("personas", ORG, true, "admin-alice");
    const bobPersona = await s.built.app.personas!.create("bob@example.com", { name: "Bob Persona" });
    assert.equal(bobPersona.status, "ok");
    const brokerSession = await s.built.brokerSessions!.create("bob@example.com", 3600, 7200);
    const bobCookie = browserSessionCookie("bob@example.com");
    assert.equal((await fetch(`${s.base}/api/sessions`, { headers: { cookie: bobCookie } })).status, 200);

    const preview = await req(s.base, "POST", "/v1/admin/users/bob%40example.com/offboard", OWNER_ACTOR, {});
    assert.equal(preview.status, 200);
    const planned: any = await preview.json();
    assert.deepEqual(
      planned.changes.map((c: any) => `${c.kind}:${c.action}`),
      ["principal:deactivate"],
    );
    assert.ok(!JSON.stringify(planned).includes("Bob private digest"));
    assert.ok(!JSON.stringify(planned).includes("Bob Persona"));

    const adminPreview: any = await (
      await req(s.base, "POST", "/v1/admin/users/bob%40example.com/offboard", ADMIN_ACTOR, {})
    ).json();
    assert.ok(adminPreview.changes.some((c: any) => c.kind === "cron" && c.id === bobCron.id));
    assert.ok(adminPreview.changes.some((c: any) => c.kind === "persona" && c.id === bobPersona.value.id));

    const applied = await req(s.base, "POST", "/v1/admin/users/bob%40example.com/offboard", OWNER_ACTOR, {
      apply: true,
    });
    assert.equal(applied.status, 200);
    assert.equal(s.built.identity.classify("bob@example.com").type, "guest");
    assert.equal(await s.built.brokerSessions!.use(brokerSession.token), null);
    assert.equal((await fetch(`${s.base}/api/sessions`, { headers: { cookie: bobCookie } })).status, 401);
    assert.equal((await s.built.app.getCron(bobCron.id))!.enabled, true);
    assert.equal((await s.built.app.personas!.detail("admin-alice", bobPersona.value.id)).status, "not_found");

    assert.equal((await req(s.base, "POST", "/v1/admin/users/bob%40example.com/reactivate", OWNER_ACTOR)).status, 200);
    assert.equal(s.built.identity.classify("bob@example.com").type, "internal");
    assert.equal((await fetch(`${s.base}/api/sessions`, { headers: { cookie: bobCookie } })).status, 200);

    assert.equal(
      (await req(s.base, "POST", "/v1/admin/users/admin-alice/offboard", OWNER_ACTOR, { apply: true })).status,
      403,
    );
    assert.equal((await req(s.base, "POST", "/v1/admin/users/admin-alice/reactivate", OWNER_ACTOR)).status, 403);
    assert.equal(
      (await req(s.base, "POST", "/v1/admin/users/owner-pat/offboard", OWNER_ACTOR, { apply: true })).status,
      400,
    );

    const ownerDmToken = await mintCapabilityToken(
      {
        actorId: "owner-pat",
        aud: CONTROL_PLANE_AUD,
        scopeId: scopeId("personal", "owner-pat"),
        exp: Date.now() + 60_000,
        ...liveRunClaims("owner-pat"),
      },
      SECRET,
    );
    const agentOffboardOwner = await fetch(`${s.base}/v1/admin/users/owner-sam/offboard`, {
      method: "POST",
      headers: { "x-agent-capability": ownerDmToken, "content-type": "application/json" },
      body: JSON.stringify({ apply: true }),
    });
    assert.equal(agentOffboardOwner.status, 403);

    const removeSam = await req(s.base, "POST", "/v1/admin/users/owner-sam/offboard", OWNER_ACTOR, { apply: true });
    assert.equal(removeSam.status, 200);
    assert.equal(s.built.identity.classify("owner-sam").type, "guest");
    assert.equal(
      (await s.built.admin.listGrants(tenant)).some((g) => g.principalId === "owner-sam"),
      false,
    );
  } finally {
    await s.close();
  }
});

test("owner cannot offboard the last owner when no org_admin exists", async () => {
  const s = await start({ adminGrants: "owner-pat:owner,owner-sam:owner" });
  try {
    await s.built.identity.deactivate("owner-sam");
    assert.equal(
      (await req(s.base, "POST", "/v1/admin/users/owner-pat/offboard", "owner-pat@default-org", { apply: true }))
        .status,
      400,
    );
    await s.built.identity.reactivate("owner-sam");
    assert.equal(
      (await req(s.base, "POST", "/v1/admin/users/owner-sam/offboard", "owner-pat@default-org", { apply: true }))
        .status,
      200,
    );
    assert.equal(
      (
        await req(
          s.base,
          "DELETE",
          `/v1/admin/grants/owner-pat?scope=${encodeURIComponent(ORG)}&role=owner`,
          "owner-pat@default-org",
        )
      ).status,
      400,
    );
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
