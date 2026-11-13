import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore, type AclStore } from "../src/acl/acl-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId } from "../src/types.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { verifyDeployGitAccess } from "../src/deploy/access-token.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresTeamStore } from "../src/teams/teams.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

function appWithFakeRuntime() {
  const deployStore = createDeployStore(testDeployBackings());
  const acl: AclStore = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 19999 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "reach-")),
  });
  const directory = createPostgresDirectoryStore(testDatabaseUrl());
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const teams = createPostgresTeamStore(
    testDatabaseUrl(),
    { enabled: async () => true },
    scopeId("org", "default-org"),
  );
  const app = createApp({
    deploy,
    acl,
    directory,
    sessions,
    teams,
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
  } as unknown as Parameters<typeof createApp>[0]);
  return { app, acl, directory, sessions, teams };
}

test("reachDeployment: org → any non-empty principal; personal → owner only; empty/unknown → denied", async () => {
  const { app } = appWithFakeRuntime();

  const org = await app.deploy({
    ownerScopeId: scopeId("org", "default-org"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal((await app.reachDeployment(org.id, "U-anyone")).status, "ok");
  assert.equal((await app.reachDeployment(org.id, "")).status, "denied");

  const personal = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal((await app.reachDeployment(personal.id, "U1")).status, "ok");
  assert.equal((await app.reachDeployment(personal.id, "U2")).status, "denied");

  assert.equal((await app.reachDeployment("no-such-id", "U1")).status, "not_found");
});

test("reachDeployment: a team-owned deployment is denied (membership ingress is a follow-up)", async () => {
  const { app } = appWithFakeRuntime();
  const team = await app.deploy({ ownerScopeId: scopeId("team", "eng"), createdBy: "U1", entrypoint: "x", files: [] });
  assert.equal((await app.reachDeployment(team.id, "U1")).status, "denied");
});

test("reachDeployment: a read grant lets a non-owner reach a personal deployment; revoke re-denies", async () => {
  const { app, acl } = appWithFakeRuntime();
  const personal = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal((await app.reachDeployment(personal.id, "U2")).status, "denied");

  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${personal.id}`,
    granteeScopeId: scopeId("personal", "U2"),
    permission: "read",
    grantedBy: "U1",
  });
  assert.equal((await app.reachDeployment(personal.id, "U2")).status, "ok");
  assert.equal((await app.reachDeployment(personal.id, "U3")).status, "denied");

  await acl.revoke(tenant, scopeId("personal", "U1"), `deployment:${personal.id}`, scopeId("personal", "U2"), "U1");
  assert.equal((await app.reachDeployment(personal.id, "U2")).status, "denied");
});

test("reachDeployment: shared-scope read grants require current channel or group membership", async () => {
  const { app, acl, directory, sessions } = appWithFakeRuntime();
  const personal = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${personal.id}`,
    granteeScopeId: scopeId("channel", "C1"),
    permission: "read",
    grantedBy: "U1",
  });
  await directory.replaceChannels(
    [{ channelId: "C1", name: "eng", isPrivate: true }],
    [{ channelId: "C1", principalId: "U2" }],
  );

  assert.equal((await app.reachDeployment(personal.id, "U2")).status, "ok");
  assert.equal((await app.reachDeployment(personal.id, "U3")).status, "denied");

  const groupDeployment = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${groupDeployment.id}`,
    granteeScopeId: scopeId("group", "G1"),
    permission: "read",
    grantedBy: "U1",
  });
  await directory.replaceGroups([{ groupId: "G1", principalId: "U4" }]);
  assert.equal((await app.reachDeployment(groupDeployment.id, "U4")).status, "ok");

  const session = await sessions.getOrCreateByThread("thread-g2", "group", scopeId("group", "G2"));
  await sessions.addParticipant(session.id, "U5");
  const priorGroupDeployment = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${priorGroupDeployment.id}`,
    granteeScopeId: scopeId("group", "G2"),
    permission: "read",
    grantedBy: "U1",
  });
  assert.equal((await app.reachDeployment(priorGroupDeployment.id, "U5")).status, "denied");
});

test("listDeploymentsForViewer includes owned and ACL-visible deployments only", async () => {
  const { app, acl, directory } = appWithFakeRuntime();
  const own = await app.deploy({
    ownerScopeId: scopeId("personal", "U2"),
    createdBy: "U2",
    entrypoint: "x",
    files: [],
  });
  const shared = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  const hidden = await app.deploy({
    ownerScopeId: scopeId("personal", "U3"),
    createdBy: "U3",
    entrypoint: "x",
    files: [],
  });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${shared.id}`,
    granteeScopeId: scopeId("channel", "C1"),
    permission: "read",
    grantedBy: "U1",
  });
  await directory.replaceChannels(
    [{ channelId: "C1", name: "eng", isPrivate: true }],
    [{ channelId: "C1", principalId: "U2" }],
  );

  const rows = await app.listDeploymentsForViewer(tenant, { actorId: "U2" });
  assert.deepEqual(rows.map((d) => d.id).sort(), [own.id, shared.id].sort());
  assert.ok(!rows.some((d) => d.id === hidden.id));
  assert.equal(rows.find((d) => d.id === own.id)?.permission, "write");
  assert.equal(rows.find((d) => d.id === shared.id)?.permission, "read");
});

test("listDeploymentsForViewer: a write grant yields permission write for a non-owner", async () => {
  const { app, acl } = appWithFakeRuntime();
  const shared = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${shared.id}`,
    granteeScopeId: scopeId("personal", "U2"),
    permission: "write",
    grantedBy: "U1",
  });
  const rows = await app.listDeploymentsForViewer(tenant, { actorId: "U2" });
  assert.equal(rows.find((d) => d.id === shared.id)?.permission, "write");
});

test("listDeploymentsForViewer matches per-app permissions with store reads independent of app count", async () => {
  const { app, acl, directory, teams } = appWithFakeRuntime();
  await teams.apply(tenant, { id: "eng", addMembers: ["U2"] }, "admin");
  await teams.apply(tenant, { id: "ops", addMembers: ["U3"] }, "admin");
  await directory.replace([{ principalId: "u2@example.com", slackId: "U2", displayName: "U2", type: "internal" }]);
  await directory.replaceChannels(
    [
      { channelId: "CPRIV", name: "priv", isPrivate: true },
      { channelId: "CPUB", name: "pub", isPrivate: false },
      { channelId: "COUT", name: "out", isPrivate: true },
    ],
    [{ channelId: "CPRIV", principalId: "U2" }],
  );
  await directory.replaceGroups([{ groupId: "G1", principalId: "U2" }], Date.now(), ["G1"], ["G1"]);
  const homes = [
    scopeId("personal", "U1"),
    scopeId("channel", "CPRIV"),
    scopeId("group", "G1"),
    scopeId("channel", "COUT"),
  ];
  const grantees = [
    scopeId("channel", "CPUB"),
    scopeId("channel", "CPRIV"),
    scopeId("org", "default-org"),
    scopeId("personal", "u2@example.com"),
    scopeId("channel", "COUT"),
    scopeId("team", "eng"),
    scopeId("team", "ops"),
  ];
  const publish = async (i: number) => {
    const d = await app.deploy({
      ownerScopeId: scopeId("personal", `owner${i}`),
      createdBy: `owner${i}`,
      createdInScope: homes[i % homes.length]!,
      entrypoint: "x",
      files: [],
    });
    if (i % 3 !== 2)
      await acl.grant(tenant, {
        ownerScopeId: d.ownerScopeId,
        ref: `deployment:${d.id}`,
        granteeScopeId: grantees[i % grantees.length]!,
        permission: i % 2 ? "write" : "read",
        grantedBy: `owner${i}`,
      });
  };
  let reads = 0;
  for (const store of [acl, directory, teams] as unknown as Record<string, unknown>[])
    for (const [key, fn] of Object.entries(store))
      if (typeof fn === "function")
        store[key] = (...args: unknown[]) => (reads++, (fn as (...a: unknown[]) => unknown).apply(store, args));
  const listedReads = async () => {
    reads = 0;
    const rows = await app.listDeploymentsForViewer(tenant, { actorId: "U2" });
    const count = reads;
    for (const d of await app.listDeployments())
      assert.equal(
        rows.find((r) => r.id === d.id)?.permission ?? null,
        await app.deploymentGitPermissionFor(d.id, { actorId: "U2" }),
      );
    return { count, rows: rows.length };
  };
  for (let i = 0; i < 4; i++) await publish(i);
  const few = await listedReads();
  for (let i = 4; i < 20; i++) await publish(i);
  const many = await listedReads();
  assert.ok(many.rows > few.rows);
  assert.equal(many.count, few.count);
});

test("HTTP: /v1/deployments?principalId= filters through viewer authz", async () => {
  const { app, acl, directory } = appWithFakeRuntime();
  const shared = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await app.deploy({ ownerScopeId: scopeId("personal", "U3"), createdBy: "U3", entrypoint: "x", files: [] });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${shared.id}`,
    granteeScopeId: scopeId("channel", "C1"),
    permission: "read",
    grantedBy: "U1",
  });
  await directory.replaceChannels(
    [{ channelId: "C1", name: "eng", isPrivate: true }],
    [{ channelId: "C1", principalId: "U2" }],
  );
  const server = createInsecureTestServer(app);
  server.listen(0);
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const r = await fetch(`${base}/v1/deployments?principalId=U2`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { deployments: Array<{ id: string; permission: string }> };
    assert.deepEqual(
      body.deployments.map((d) => d.id),
      [shared.id],
    );
    assert.equal(body.deployments[0]!.permission, "read");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP: /v1/deployments/:id shows a deployment only to principals who can see it", async () => {
  const { app, acl, directory } = appWithFakeRuntime();
  const shared = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    name: "shared-app",
    entrypoint: "x",
    files: [],
  });
  const hidden = await app.deploy({
    ownerScopeId: scopeId("personal", "U3"),
    createdBy: "U3",
    name: "hidden-app",
    entrypoint: "x",
    files: [],
  });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${shared.id}`,
    granteeScopeId: scopeId("channel", "C1"),
    permission: "read",
    grantedBy: "U1",
  });
  await directory.replaceChannels(
    [{ channelId: "C1", name: "eng", isPrivate: true }],
    [{ channelId: "C1", principalId: "U2" }],
  );
  const server = createInsecureTestServer(app);
  server.listen(0);
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const view = async (ref: string, principal?: string) => {
      const r = await fetch(`${base}/v1/deployments/${ref}${principal ? `?principalId=${principal}` : ""}`);
      const body = (await r.json()) as { deployment?: { id: string; permission?: string } };
      return [r.status, body.deployment?.id, body.deployment?.permission];
    };
    assert.deepEqual(await view(shared.id, "U2"), [200, shared.id, "read"]);
    assert.deepEqual(await view("shared-app", "U2"), [200, shared.id, "read"]);
    assert.deepEqual(await view(shared.id, "U1"), [200, shared.id, "write"]);
    assert.deepEqual(await view(hidden.id, "U2"), [404, undefined, undefined]);
    assert.deepEqual(await view("hidden-app", "U2"), [404, undefined, undefined]);
    assert.deepEqual(await view(hidden.id), [400, undefined, undefined]);
    assert.deepEqual(await view("missing-app", "U2"), [404, undefined, undefined]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP: each /v1/deployments row carries an authed, clonable gitUrl when ingress is configured", async () => {
  const { app, acl, directory } = appWithFakeRuntime();
  const shared = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${shared.id}`,
    granteeScopeId: scopeId("channel", "C1"),
    permission: "read",
    grantedBy: "U1",
  });
  await directory.replaceChannels(
    [{ channelId: "C1", name: "eng", isPrivate: true }],
    [{ channelId: "C1", principalId: "U2" }],
  );
  const secret = "deployments-list-secret".repeat(3);
  const server = createServer(app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: secret,
    apiBaseUrl: "https://core.test",
    publicUrl: "https://web.test",
  });
  server.listen(0);
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const path = "/v1/deployments?principalId=U2";
    const headers = signedRequestHeaders(secret, "GET", path, "", {}) as Record<string, string>;
    const r = await fetch(`${base}${path}`, { headers });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { deployments: Array<{ id: string; permission: string; gitUrl?: string }> };
    assert.equal(body.deployments.length, 1);
    const row = body.deployments[0]!;
    assert.equal(row.permission, "read");
    assert.ok(row.gitUrl);
    const gitUrl = new URL(row.gitUrl!);
    assert.equal(gitUrl.host, "core.test");
    assert.equal(gitUrl.pathname, `/v1/deployments/${shared.id}/git`);
    assert.ok(gitUrl.password.length > 0);
    const access = await verifyDeployGitAccess(secret, gitUrl.password);
    assert.equal(access?.deploymentId, shared.id);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reachDeployment: an org grant on a personal deployment opens it to any verified principal", async () => {
  const { app, acl } = appWithFakeRuntime();
  const personal = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${personal.id}`,
    granteeScopeId: scopeId("org", "default-org"),
    permission: "read",
    grantedBy: "U1",
  });
  assert.equal((await app.reachDeployment(personal.id, "U-anyone")).status, "ok");
  assert.equal((await app.reachDeployment(personal.id, "")).status, "denied");
});

test("reachDeployment: admin bypass reaches running deployments without owner scope membership", async () => {
  const { app } = appWithFakeRuntime();
  const personal = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal((await app.reachDeployment(personal.id, "U2")).status, "denied");
  assert.equal((await app.reachDeployment(personal.id, "", { bypassAcl: true })).status, "ok");
});
