import { createToolContext } from "../src/tools/primitives.ts";
import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createControlService } from "../src/api/control-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { CONTROL_PLANE_AUD, type CapabilityClaims } from "../src/auth/capability-token.ts";
import {
  isLiveResourceAdmin,
  withResourceAuthority,
  type ResourceAuthorityDeps,
} from "../src/admin/resource-authority.ts";

const claims = (patch: Partial<CapabilityClaims> = {}): CapabilityClaims => ({
  actorId: "admin-alice",
  scopeId: "personal:admin-alice",
  aud: CONTROL_PLANE_AUD,
  liveActor: true,
  exp: Date.now() + 60_000,
  ...patch,
});

function authorityFixture() {
  let admin = true;
  let active = true;
  let open = true;
  const auditLog = createAuditLog();
  const deps: ResourceAuthorityDeps = {
    admin: { adminStatusOf: async () => ({ isAdmin: admin, role: admin ? "org_admin" : undefined }) },
    identity: { refresh: async () => {}, classify: (id) => ({ id, type: active ? "internal" : "guest" }) },
    config: { resolveSharingPostureDurable: async () => (open ? "open" : "isolated") },
    auditLog,
  };
  return {
    deps,
    auditLog,
    admin: (v: boolean) => (admin = v),
    active: (v: boolean) => (active = v),
    open: (v: boolean) => (open = v),
  };
}

test("live resource authority is non-transferable and rechecks identity, admin status and posture", async () => {
  const f = authorityFixture();
  const can = (cap = claims()) => withResourceAuthority(f.deps, cap, "test", () => isLiveResourceAdmin("admin-alice"));
  assert.equal(await can(), true);
  assert.equal(await can(claims({ scopeId: "group:room", liveActor: false, liveAuthor: true })), true);
  for (const patch of [
    { liveActor: false },
    { triggered: true },
    { botActor: true },
    { deployment: "app" },
    { aud: "credential-broker" },
    { aud: undefined },
    { exp: 0 },
    { actorId: "someone-else" },
  ])
    assert.equal(await can(claims(patch)), false, JSON.stringify(patch));
  f.open(false);
  assert.equal(await can(claims({ scopeId: "group:room" })), false);
  assert.equal(await can(), true);
  f.open(true);
  await withResourceAuthority(f.deps, claims({ scopeId: "group:room" }), "revoke", async () => {
    assert.equal(await isLiveResourceAdmin("admin-alice"), true);
    f.admin(false);
    assert.equal(await isLiveResourceAdmin("admin-alice"), false);
    f.admin(true);
    f.active(false);
    assert.equal(await isLiveResourceAdmin("admin-alice"), false);
    f.active(true);
    f.open(false);
    assert.equal(await isLiveResourceAdmin("admin-alice"), false);
  });
  assert.equal(await isLiveResourceAdmin("admin-alice"), false);
  let release!: () => void;
  let detached!: Promise<boolean>;
  await withResourceAuthority(f.deps, claims(), "detach", async () => {
    detached = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => isLiveResourceAdmin("admin-alice"));
  });
  release();
  assert.equal(await detached, false);
});

test("live admin repairs another owner's cron and webhook without changing trigger authority", async () => {
  const built = buildApp(testConfig());
  const control = createControlService(built.app, undefined, built.admin);
  const f = authorityFixture();
  const cap = claims();
  const cron = await built.app.createCron({
    owner: "owner",
    createdBy: "owner",
    ownerScopeId: "personal:owner",
    action: "original task",
    schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
  });
  const webhook = await built.app.createWebhook({
    owner: "owner",
    createdBy: "owner",
    ownerScopeId: "personal:owner",
    action: "original task",
    verification: { scheme: "hmac-sha256", secret: "synthetic-secret" },
  });
  assert.equal((await control.patchCron(cron.id, { enabled: false }, cap)).ok, false);
  assert.equal((await control.disableWebhook(webhook.id, cap)).ok, false);
  await withResourceAuthority({ ...f.deps, auditLog: built.auditLog }, cap, "repair", async () => {
    const result = await control.patchCron(
      cron.id,
      { title: "repaired", schedule: { cron: "30 10 * * 1-5", timezone: "UTC" } },
      cap,
    );
    assert.equal(result.ok, true);
    assert.equal((await control.setCronEnabled(cron.id, false, cap)).ok, true);
    assert.equal((await control.disableWebhook(webhook.id, cap)).ok, true);
    assert.equal((await control.patchCron(cron.id, { runAs: "scopeShared" }, cap)).ok, false);
    assert.equal((await control.patchCron(cron.id, { unattendedGrants: ["admin.sessions.read"] }, cap)).ok, false);
  });
  const updated = (await built.app.getCron(cron.id))!;
  assert.equal(updated.owner, "owner");
  assert.equal(updated.createdBy, "owner");
  assert.equal(updated.ownerScopeId, "personal:owner");
  assert.equal(updated.enabled, false);
  assert.equal(updated.runAs, cron.runAs);
  assert.deepEqual(updated.unattendedGrants, cron.unattendedGrants);
  const hook = (await built.app.getWebhook(webhook.id))!;
  assert.equal(hook.owner, "owner");
  assert.equal(hook.createdBy, "owner");
  assert.equal(hook.enabled, false);
  assert.ok((await built.auditLog.events()).some((e) => e.action === "cron_update" && e.principalId === "admin-alice"));
  const protectedCron = await built.app.createCron({
    owner: "owner",
    createdBy: "owner",
    ownerScopeId: "personal:owner",
    action: "privileged",
    schedule: { everyMs: 60_000 },
    unattendedGrants: ["admin.sessions.read"],
  });
  await withResourceAuthority(f.deps, cap, "protected", async () => {
    assert.equal((await control.patchCron(protectedCron.id, { action: "changed" }, cap)).ok, false);
    assert.equal(
      (
        await control.patchCron(
          protectedCron.id,
          { schedule: { everyMs: 120_000 }, title: "repaired schedule", enabled: false, archived: true },
          cap,
        )
      ).ok,
      true,
    );
    assert.equal((await control.patchCron(protectedCron.id, { enabled: true }, cap)).ok, false);
    assert.equal((await control.patchCron(protectedCron.id, { archived: false }, cap)).ok, false);
    assert.equal((await control.setCronEnabled(protectedCron.id, true, cap)).ok, false);
    assert.equal((await control.setCronEnabled(protectedCron.id, false, cap)).ok, true);
  });
  assert.deepEqual((await built.app.getCron(protectedCron.id))!.unattendedGrants, ["admin.sessions.read"]);
});

test("artifact grants permit live admin repairs but never service credential grants", async () => {
  const acl = createAclStore();
  const f = authorityFixture();
  for (const ref of ["report.txt", "skill:skill-id", "deployment:app-id", "cron:cron-id"]) {
    const grant = {
      ownerScopeId: "personal:owner",
      ref,
      granteeScopeId: "personal:reader",
      permission: "read" as const,
      grantedBy: "admin-alice",
    };
    await assert.rejects(acl.grant(grant));
    await withResourceAuthority(f.deps, claims(), `share ${ref}`, async () => {
      await acl.grant(grant);
      await acl.revoke(grant.ownerScopeId, ref, grant.granteeScopeId, "admin-alice");
    });
  }
  await withResourceAuthority(f.deps, claims(), "credentials remain separate", async () => {
    await assert.rejects(
      acl.grant({
        ownerScopeId: "personal:owner",
        ref: "service-cred:secret",
        granteeScopeId: "personal:reader",
        permission: "read",
        grantedBy: "admin-alice",
      }),
    );
  });
});

test("foreign app publish, rename, public access and shares retain creator and audit administrator", async () => {
  const f = authorityFixture();
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    acl,
    auditLog: f.auditLog,
    deployDir: mkdtempSync(join(tmpdir(), "resource-admin-deploy-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 12345 }),
      destroy: async () => {},
    },
  });
  const app = await deploy.deployOrUpdate({
    ownerScopeId: "personal:owner",
    createdBy: "owner",
    name: "owner-app",
    entrypoint: "node server.js",
    env: { ACTING: "owner" },
    defaultAudience: { contextScopeId: "group:owners", granteeScopeIds: ["group:owners"], snapshotAt: 1 },
    files: [{ path: "server.js", data: "synthetic" }],
  });
  const patch = {
    ownerScopeId: "personal:admin-alice",
    createdBy: "admin-alice",
    name: "owner-app",
    entrypoint: "node server.js",
    files: [{ path: "server.js", data: "repaired" }],
  };
  await assert.rejects(deploy.deployOrUpdate(patch));
  const tools = createToolContext({
    sandbox: {
      exportFiles: async () => [{ area: "workspace", path: "server.js", data: Buffer.from("admin repair") }],
    } as never,
    provision: async () => ({ id: "synthetic", rootDir: "/workspace" }),
    layers: [{ scopeId: "personal:admin-alice", mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy,
    acl,
    createdBy: "admin-alice",
    resourceAuthority: f.deps,
    controlClaims: claims(),
    actingSlackUserId: "admin-alice",
    layerAuth: { credentialPaths: [], splitEnvTemplates: [{ ACTING: "{actingSlackUserId}" }] },
  });
  await tools.publish({ name: "owner-app", entrypoint: "node server.js" });
  assert.equal((await deploy.getDeployment(app.id))!.versions.at(-1)!.env?.ACTING, "owner");
  assert.deepEqual(await deploy.deploymentGrantees(app.id), [{ scope: "group:owners", permission: "read" }]);

  await withResourceAuthority(f.deps, claims(), "publish owner-app", async () => {
    const updated = await deploy.deployOrUpdate(patch);
    assert.equal(updated.ownerScopeId, app.ownerScopeId);
    assert.equal(updated.createdBy, app.createdBy);
    await deploy.deployOrUpdate({ ...patch, renameFrom: "owner-app", name: "renamed-app" });
    await deploy.setDeploymentPublic(app.id, true, { createdBy: "admin-alice" });
    await deploy.shareDeployment(app.id, "personal:reader", "read", { createdBy: "admin-alice" });
    assert.equal((await deploy.reachDeployment(app.id, "admin-alice")).status, "ok");
    await deploy.deployOrUpdate({
      ...patch,
      name: "renamed-app",
      defaultAudience: { contextScopeId: "group:admin", granteeScopeIds: [], snapshotAt: 2, force: true },
    });
    assert.ok(
      (await f.auditLog.events()).some((e) => e.action === "deploy_unshare" && e.principalId === "admin-alice"),
    );
  });
  assert.equal((await deploy.getDeployment(app.id))!.createdBy, "owner");
  assert.ok((await f.auditLog.events()).some((e) => e.action === "deploy_version" && e.principalId === "admin-alice"));
  await assert.rejects(deploy.setDeploymentPublic(app.id, false, { createdBy: "admin-alice" }));
});

test("foreign skills use existing resource APIs under live admin authority", async () => {
  const built = buildApp(testConfig());
  const f = authorityFixture();
  const control = createControlService(built.app, undefined, built.admin);
  const skill = await built.skills.create({
    scopeId: "personal:owner",
    createdBy: "owner",
    manifest: { name: "owner-skill", description: "synthetic", body: "before", requiredCapabilities: [] },
  });
  assert.equal(await built.app.updateOwnedSkill(skill.id, "admin-alice", { body: "after" }), null);
  await withResourceAuthority(f.deps, claims(), "skill repair", async () => {
    const result = await built.app.updateOwnedSkill(skill.id, "admin-alice", { body: "after" });
    assert.ok(result && result !== "trigger_blocked");
    assert.equal(result.createdBy, "owner");
    assert.equal(result.scopeId, "personal:owner");
    const shared = await control.shareArtifact({ type: "skill", id: skill.id, scope: "personal:reader" }, claims());
    assert.equal(shared.ok, true);
    await built.skills.review(skill.id, "owner", []);
    await built.skills.publish(skill.id);
  });
  const open = claims({ scopeId: "group:room", liveActor: false, liveAuthor: true });
  await withResourceAuthority(f.deps, open, "promote", async () => {
    assert.equal((await control.shareArtifact({ type: "skill", id: skill.id, scope: "org" }, open)).ok, true);
  });
});

test("resource HTTP and Git repair verify the live turn without minting lasting access", async () => {
  const f = authorityFixture();
  const secret = "synthetic-admin-resource-secret".repeat(2);
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore: createDeployStore({ git: { repoRoot: mkdtempSync(join(tmpdir(), "admin-git-repo-")) } }),
    acl,
    auditLog: f.auditLog,
    deployDir: mkdtempSync(join(tmpdir(), "admin-git-deploy-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 12345 }),
      destroy: async () => {},
    },
  });
  const identity = createIdentityService();
  const app = createApp({
    deploy,
    acl,
    identity,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
  } as Parameters<typeof createApp>[0]);
  const server = createServer(app, {
    signingSecret: secret,
    identity,
    admin: { ...createAdminService(), adminStatusOf: f.deps.admin!.adminStatusOf },
    auditLog: f.auditLog,
  });
  server.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const d = await deploy.deploy({
    ownerScopeId: "personal:owner",
    createdBy: "owner",
    entrypoint: "node server.js",
    files: [{ path: "server.js", data: "v1" }],
  });
  const token = await mintCapabilityToken(claims(), secret);
  const headers = { "x-agent-capability": token, "content-type": "application/json" };
  const remote = `${base}/v1/deployments/${d.id}/git`;
  const git = promisify(execFile);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Synthetic",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Synthetic",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  try {
    const redeploy = await fetch(`${base}/v1/deployments/${d.id}/redeploy`, {
      method: "POST",
      headers,
      body: JSON.stringify({ entrypoint: "node server.js", files: [{ path: "server.js", data: "v2" }] }),
    });
    assert.equal(redeploy.status, 200, await redeploy.text());
    const rollback = await fetch(`${base}/v1/deployments/${d.id}/rollback`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rollback.status, 200, await rollback.text());
    assert.equal((await fetch(`${base}/v1/deployments/${d.id}/git-url`, { headers })).status, 403);
    const clone = join(mkdtempSync(join(tmpdir(), "admin-git-clone-")), "app");
    await git("git", ["-c", `http.extraHeader=x-agent-capability: ${token}`, "clone", remote, clone], { env });
    await writeFile(join(clone, "server.js"), "repaired by admin");
    await git("git", ["add", "."], { cwd: clone, env });
    await git("git", ["commit", "-m", "synthetic repair"], { cwd: clone, env });
    await git("git", ["-c", `http.extraHeader=x-agent-capability: ${token}`, "push", "origin", "HEAD:current"], {
      cwd: clone,
      env,
    });
    assert.equal((await deploy.getDeployment(d.id))!.createdBy, "owner");
    assert.equal((await deploy.getDeployment(d.id))!.ownerScopeId, "personal:owner");
    assert.deepEqual(await deploy.deploymentGrantees(d.id), []);
    for (const patch of [
      { liveActor: false },
      { scopeId: "group:isolated" },
      { botActor: true },
      { aud: "credential-broker" },
    ]) {
      const denied = await mintCapabilityToken(claims(patch), secret);
      assert.notEqual(
        (await fetch(`${remote}/info/refs?service=git-upload-pack`, { headers: { "x-agent-capability": denied } }))
          .status,
        200,
      );
    }
    const runPush = app.runDeploymentGitPush.bind(app);
    app.runDeploymentGitPush = async (id, fn) => {
      f.admin(false);
      return runPush(id, fn);
    };
    const revoked = await fetch(`${remote}/git-receive-pack`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-git-receive-pack-request" },
      body: Buffer.alloc(0),
    });
    assert.equal(revoked.status, 403, await revoked.text());
    assert.notEqual((await fetch(`${remote}/info/refs?service=git-upload-pack`, { headers })).status, 200);
    assert.equal(
      (
        await fetch(`${base}/v1/deployments/${d.id}/rollback`, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1 }),
        })
      ).status,
      403,
    );
    f.admin(true);
    await identity.deactivate("admin-alice");
    assert.notEqual((await fetch(`${remote}/info/refs?service=git-upload-pack`, { headers })).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("live admin maintains loops and environments without authorizing another owner's sends", async () => {
  const built = buildApp(testConfig());
  const secret = "synthetic-loop-admin-secret".repeat(2);
  const server = createServer(built.app, {
    signingSecret: secret,
    capabilitySecret: secret,
    identity: built.identity,
    admin: built.admin,
    config: built.config,
    auditLog: built.auditLog,
    loops: built.loops,
  });
  server.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { loop } = await built.loops.store.create({
    owner: "owner",
    createdBy: "owner",
    ownerScopeId: "personal:owner",
    name: "synthetic",
    playbook: "inspect queue",
    successCondition: "queue inspected",
    shipActions: [{ action: "send", gate: "hold" }],
  });
  await built.app.createEnvironment({ scopeId: "personal:owner", name: "owner-environment", actorId: "owner" });
  const call = async (path: string, method: string, body: unknown, cap = claims()) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", "x-agent-capability": await mintCapabilityToken(cap, secret) },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await call(`/v1/loops/${loop.id}`, "PATCH", { state: "paused", playbook: "repaired inspection" })).status,
      200,
    );
    assert.equal((await built.loops.store.get(loop.id))!.owner, "owner");
    assert.equal((await built.loops.store.get(loop.id))!.createdBy, "owner");
    assert.equal(
      (await call(`/v1/loops/${loop.id}`, "PATCH", { shipActions: [{ action: "send", gate: "auto" }] })).status,
      403,
    );
    for (const [suffix, body] of [
      ["autopilot", { enabled: true }],
      ["grants", { shipAction: "send" }],
      ["outputs/output/decide", { decision: "ship" }],
    ] as const) {
      assert.equal((await call(`/v1/loops/${loop.id}/${suffix}`, "POST", body)).status, 403);
    }
    assert.equal(
      (await call(`/v1/loops/${loop.id}`, "PATCH", { state: "enabled" }, claims({ liveActor: false }))).status,
      403,
    );
    assert.equal(
      (await call("/v1/environments/attach", "POST", { name: "owner-environment" }, claims({ liveActor: false })))
        .status,
      403,
    );
    assert.equal((await call("/v1/environments/attach", "POST", { name: "owner-environment" })).status, 200);
    assert.equal((await built.app.resolveEnvironmentByName("owner-environment"))!.ownerActorId, "owner");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
