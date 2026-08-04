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
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { verifyDeployGitAccess } from "../src/deploy/access-token.ts";

function appWithFakeRuntime() {
  const deployStore = createDeployStore();
  const acl: AclStore = createAclStore();
  const deploy = createDeployService({
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
  const directory = createDirectoryStore();
  const sessions = createMemorySessionStore();
  const app = createApp({
    deploy,
    acl,
    directory,
    sessions,
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  return { app, acl, directory, sessions };
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

  await acl.grant({
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${personal.id}`,
    granteeScopeId: scopeId("personal", "U2"),
    permission: "read",
    grantedBy: "U1",
  });
  assert.equal((await app.reachDeployment(personal.id, "U2")).status, "ok");
  assert.equal((await app.reachDeployment(personal.id, "U3")).status, "denied");

  await acl.revoke(scopeId("personal", "U1"), `deployment:${personal.id}`, scopeId("personal", "U2"), "U1");
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
  await acl.grant({
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
  await acl.grant({
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
  await acl.grant({
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
  await acl.grant({
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

  const rows = await app.listDeploymentsForViewer("U2");
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
  await acl.grant({
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${shared.id}`,
    granteeScopeId: scopeId("personal", "U2"),
    permission: "write",
    grantedBy: "U1",
  });
  const rows = await app.listDeploymentsForViewer("U2");
  assert.equal(rows.find((d) => d.id === shared.id)?.permission, "write");
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
  await acl.grant({
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

test("HTTP: each /v1/deployments row carries an authed, clonable gitUrl when ingress is configured", async () => {
  const { app, acl, directory } = appWithFakeRuntime();
  const shared = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await acl.grant({
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
  await acl.grant({
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
