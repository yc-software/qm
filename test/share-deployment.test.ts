import { authBrokerRoutes } from "../src/api/routes/auth-broker.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createControlService } from "../src/api/control-service.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, deploymentView } from "../src/api/app.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createToolContext, type ToolContext } from "../src/tools/primitives.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService, type DeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore, type AclStore } from "../src/acl/acl-store.ts";
import {
  resolveShareTarget,
  shareDeployment,
  renameDeployment,
  archiveDeployment,
  restoreDeployment,
  getDeployment,
  getDeploymentShares,
  setDeploymentDisplayName,
} from "../src/api/routes/deployments.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import type { RecipientResolution } from "../src/directory/directory-store.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

type Dir = { resolve: (orgId: string, q: string) => Promise<RecipientResolution> };

function makeDeploy(canManageEmail?: (email: string) => Promise<boolean>): { deploy: DeployService; acl: AclStore } {
  const acl: AclStore = createAclStore();
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 20200 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    ...(canManageEmail ? { canManageEmail } : {}),
    deployDir: mkdtempSync(join(tmpdir(), "share-api-")),
  });
  return { deploy, acl };
}

function apiHarness(directory?: Dir) {
  const { deploy, acl } = makeDeploy();
  const app = createApp({
    deploy,
    identity: createIdentityService(),
    ...(directory ? { directory } : {}),
  } as unknown as Parameters<typeof createApp>[0]);
  return { app, deploy, acl };
}

const cap = (actorId: string, orgId = "acme"): CapabilityClaims =>
  ({ actorId, orgId, scopeId: scopeId("personal", actorId), exp: 9_999_999_999 }) as CapabilityClaims;

function callShare(app: ReturnType<typeof createApp>, capability: CapabilityClaims | null, id: string, body: unknown) {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(s: number) {
      out.status = s;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const ctx = { res, app, params: { id }, body, capability } as unknown as ApiCtx;
  return shareDeployment(ctx).then(() => out);
}

const one = (principalId: string, displayName: string): RecipientResolution => ({
  kind: "one",
  member: { principalId, displayName, type: "internal" },
});

function callManage(
  handle: (ctx: ApiCtx) => Promise<void>,
  app: ReturnType<typeof createApp>,
  capability: CapabilityClaims | null,
  id: string,
  body: unknown,
) {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(s: number) {
      out.status = s;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const ctx = { res, app, params: { id }, body, capability } as unknown as ApiCtx;
  return handle(ctx).then(() => out);
}

function callDetail(app: ReturnType<typeof createApp>, capability: CapabilityClaims, id: string) {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(s: number) {
      out.status = s;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const ctx = {
    res,
    app,
    params: { id },
    capability,
    secret: "test-secret",
    deps: { apiBaseUrl: "https://api.example", publicUrl: "https://web.example" },
    url: new URL(`http://localhost/v1/deployments/${id}`),
    req: { headers: { host: "localhost" } },
  } as unknown as ApiCtx;
  return getDeployment(ctx).then(() => out);
}

test("manage endpoints (rename/display-name/archive): agent capability is owner-scoped, source auth is trusted", async () => {
  const { app, deploy } = apiHarness();
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "owned",
  });

  assert.equal((await callManage(renameDeployment, app, cap("U2"), d.id, { name: "hijack" })).status, 403);
  assert.equal(
    (await callManage(setDeploymentDisplayName, app, cap("U2"), d.id, { displayName: "Hijack" })).status,
    403,
  );
  assert.equal((await callManage(archiveDeployment, app, cap("U2"), d.id, {})).status, 403);

  assert.equal(
    (await callManage(setDeploymentDisplayName, app, cap("U1"), d.id, { displayName: "Owned" })).status,
    200,
  );
  assert.equal((await callManage(renameDeployment, app, cap("U1"), d.id, { name: "renamed" })).status, 200);

  assert.equal((await callManage(archiveDeployment, app, null, d.id, {})).status, 200);
  assert.equal((await deploy.reachDeployment("renamed", "U1")).status, "not_found");
});

test("deployment detail is viewer-gated and fixes the permission/gitUrl wire contract", async () => {
  const { app } = apiHarness();
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "details",
  });

  const visible = await callDetail(app, cap("U1"), d.id);
  assert.equal(visible.status, 200);
  assert.equal(visible.body.deployment.permission, "write");
  assert.equal(typeof visible.body.deployment.gitUrl, "string");
  assert.equal(new URL(visible.body.deployment.gitUrl).origin, "https://api.example");
  assert.equal(visible.body.deployment.currentVersion, 1);
  assert.equal(typeof visible.body.deployment.versions[0].createdAt, "number");
  assert.equal(visible.body.deployment.versions[0].snapshotDir, undefined);
  assert.equal(visible.body.deployment.versions[0].entrypoint, undefined);
  assert.equal(visible.body.deployment.publicUrl, undefined);
  assert.equal((await callDetail(app, cap("U3"), d.id)).status, 404);
});

test("deployment projections omit runtime secrets and local paths", async () => {
  const { app } = apiHarness();
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    env: { SECRET: "value" },
  });
  const stored = (await app.listDeployments()).find((row) => row.id === d.id)!;
  stored.endpoint = {
    host: "internal",
    port: 123,
    publicUrl: "https://app.example",
    proxyHeaders: { authorization: "secret" },
  };
  const view = deploymentView(stored) as Record<string, any>;

  assert.equal(view.publicUrl, undefined);
  assert.equal(view.endpoint, undefined);
  assert.equal(view.versions[0].env, undefined);
  assert.equal(view.versions[0].snapshotDir, undefined);
  assert.equal(view.versions[0].homeDir, undefined);
  assert.equal(view.versions[0].entrypoint, undefined);
  assert.equal(view.versions[0].image, undefined);
});

test("restore endpoint is manage-gated and reactivates the archived current version", async () => {
  const { app } = apiHarness();
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "restore-me",
  });
  await app.archiveDeployment(d.id);

  assert.equal((await callManage(restoreDeployment, app, cap("U2"), d.id, {})).status, 403);
  const restored = await callManage(restoreDeployment, app, cap("U1"), d.id, {});
  assert.equal(restored.status, 200);
  assert.equal(restored.body.deployment.status, "running");
  assert.equal(restored.body.deployment.currentVersion, 1);
  assert.equal(restored.body.deployment.permission, "write");
  assert.equal(restored.body.deployment.endpoint, undefined);
  assert.equal(restored.body.deployment.publicUrl, undefined);
  assert.equal(restored.body.deployment.versions[0].snapshotDir, undefined);

  await app.archiveDeployment(d.id);
  const restoredBySlug = await callManage(restoreDeployment, app, cap("U1"), "restore-me", {});
  assert.equal(restoredBySlug.status, 200);
  assert.equal(restoredBySlug.body.deployment.id, d.id);
});

test('share endpoint: "everyone" grants org reach — a non-owner can reach it; access:none re-denies', async () => {
  const { app, deploy } = apiHarness();
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "dead-reckoning",
  });
  assert.equal((await deploy.reachDeployment("dead-reckoning", "U2")).status, "denied");

  const r = await callShare(app, cap("U1"), "dead-reckoning", { scope: "org" });
  assert.equal(r.status, 200);
  assert.equal(r.body.target.scope, scopeId("org", "default-org"));
  assert.match(r.body.reach, /everyone in default-org/);
  assert.equal((await deploy.reachDeployment("dead-reckoning", "U2")).status, "ok");

  const off = await callShare(app, cap("U1"), "dead-reckoning", { scope: "org", access: "none" });
  assert.equal(off.status, 200);
  assert.equal((await deploy.reachDeployment("dead-reckoning", "U2")).status, "denied");
});

test("share endpoint: recipient resolves a teammate via the directory → only that person reaches", async () => {
  const directory: Dir = {
    resolve: async (q) => (q.toLowerCase() === "carol" ? one("U-carol", "Carol") : { kind: "none" }),
  };
  const { app, deploy } = apiHarness(directory);
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "memos",
  });

  const r = await callShare(app, cap("U1"), "memos", { recipient: "carol" });
  assert.equal(r.status, 200);
  assert.equal(r.body.target.scope, scopeId("personal", "U-carol"));
  assert.equal((await deploy.reachDeployment("memos", "U-carol")).status, "ok");
  assert.equal((await deploy.reachDeployment("memos", "U-other")).status, "denied");

  assert.equal((await callShare(app, cap("U1"), "memos", { recipient: "nobody" })).status, 404);
});

test("share endpoint: only the owner can share (non-owner capability → 403)", async () => {
  const { app } = apiHarness();
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "owned",
  });
  const r = await callShare(app, cap("U2"), "owned", { scope: "org" });
  assert.equal(r.status, 403);
  assert.match(r.body.message, /only the owner/);
});

test("share endpoint: unknown app → 404; no capability → 403; bad/ambiguous/missing args → 400", async () => {
  const { app } = apiHarness();
  assert.equal((await callShare(app, cap("U1"), "ghost", { scope: "org" })).status, 404);
  assert.equal((await callShare(app, null, "ghost", { scope: "org" })).status, 403);
  await app.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [], name: "a" });
  assert.equal(
    (await callShare(app, cap("U1"), "a", { scope: "org", access: "bogus" })).status,
    400,
    "bad access → 400",
  );
  assert.equal((await callShare(app, cap("U1"), "a", {})).status, 400, "no target → 400");
  assert.equal((await callShare(app, cap("U1"), "a", { public: "yes" })).status, 400, "public is boolean");
  assert.equal(
    (await callShare(app, cap("U1"), "a", { public: true, scope: "org" })).status,
    400,
    "public and authenticated targets change separately",
  );
  assert.equal(
    (await callShare(app, cap("U1"), "a", { scope: "org", recipient: "carol" })).status,
    400,
    "both targets → 400",
  );
  assert.equal((await callShare(app, cap("U1"), "a", { scope: "not-a-scope" })).status, 400, "bad scope id → 400");
});

test("share endpoint: access:manage grants write (reach + manage)", async () => {
  const directory: Dir = { resolve: async () => one("U-eng", "Eng") };
  const { app, deploy } = apiHarness(directory);
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "mgmt",
  });
  const r = await callShare(app, cap("U1"), "mgmt", { recipient: "eng", access: "manage" });
  assert.equal(r.status, 200);
  assert.deepEqual(await deploy.deploymentGrantees("mgmt"), [
    { scope: scopeId("personal", "U-eng"), permission: "write" },
  ]);
});

test('resolveShareTarget: scope "org"→org, scope id verbatim, recipient→personal, none/ambiguous/invalid', async () => {
  const directory: Dir = {
    resolve: async (q) => {
      if (q === "ann") return one("U-ann", "Ann");
      if (q === "j") {
        return {
          kind: "ambiguous",
          candidates: [
            { principalId: "a", displayName: "J A", type: "internal" },
            { principalId: "b", displayName: "J B", type: "internal" },
          ],
        };
      }
      return { kind: "none" };
    },
  };
  const { app } = apiHarness(directory);
  assert.deepEqual(await resolveShareTarget(app, { scope: "org" }), {
    kind: "ok",
    scope: "org:default-org",
    label: "everyone in the org",
  });
  assert.deepEqual(await resolveShareTarget(app, { scope: "personal:U9" }), {
    kind: "ok",
    scope: "personal:U9",
    label: "personal:U9",
  });
  assert.deepEqual(await resolveShareTarget(app, { recipient: "ann" }), {
    kind: "ok",
    scope: "personal:U-ann",
    label: "Ann",
  });
  assert.equal((await resolveShareTarget(app, { recipient: "ghost" })).kind, "none");
  assert.equal((await resolveShareTarget(app, { recipient: "j" })).kind, "ambiguous");
  assert.equal((await resolveShareTarget(app, {})).kind, "invalid");
  assert.equal((await resolveShareTarget(app, { scope: "nope" })).kind, "invalid");
});

const APP_FILES = [{ path: "server.js", data: new TextEncoder().encode("listen") }];
const appSandbox = (): Sandbox => {
  const under = (dir: string) => {
    const d = (dir ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
    return APP_FILES.filter((f) => !d || d === "." || f.path === d || f.path.startsWith(`${d}/`));
  };
  return {
    listDir: async (_h: SandboxHandle, dir: string) => under(dir).map((f) => f.path),
    readFileBytes: async (_h: SandboxHandle, p: string) => APP_FILES.find((f) => f.path === p)?.data ?? null,
    exportFiles: async (
      _h: SandboxHandle,
      opts?: { include?: Array<"workspace" | "home">; includePaths?: readonly string[] },
    ) => {
      if (opts?.include?.includes("home")) return [];
      const dir = opts?.includePaths?.[0] ?? "";
      return under(dir).map((f) => ({ area: "workspace" as const, path: f.path, data: f.data }));
    },
  } as unknown as Sandbox;
};

function toolCtx(deploy: DeployService): ToolContext {
  return createToolContext({
    sandbox: appSandbox(),
    provision: async () => ({}) as SandboxHandle,
    layers: [
      { scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" },
      { scopeId: scopeId("org", "default-org"), mountPath: "global", mode: "ro" },
    ],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy,
    acl: {} as never,
    createdBy: "U1",
  } as never);
}

test('publish share:[{scope:"org"}] resolves to the org — truthful readback, real reach (the QM bug)', async () => {
  const { deploy } = makeDeploy();
  const r = await toolCtx(deploy).publish({
    entrypoint: "x",
    name: "wide",
    share: [{ scope: "org", permission: "read" }],
  });
  assert.equal(r.audience?.kind, "org", "an org share is reported as org, not owner-only");
  assert.ok(!r.audience?.note, "no scary owner-only note when reach was actually granted");
  assert.equal((await deploy.reachDeployment("wide", "U2")).status, "ok");
});

test("publish keeps apps private by default and requires an explicit public opt-in", async () => {
  const { deploy } = makeDeploy();
  const privateApp = await toolCtx(deploy).publish({ entrypoint: "x", name: "private-app" });
  assert.equal(privateApp.public, undefined);
  assert.equal((await deploy.getDeployment("private-app"))?.public, undefined);

  const publicApp = await toolCtx(deploy).publish({ entrypoint: "x", name: "public-app", public: true });
  assert.equal(publicApp.public, true);
  assert.equal((await deploy.getDeployment("public-app"))?.public, true);
});

test("publish rejects a garbage share target instead of silently creating a dead grant", async () => {
  const { deploy } = makeDeploy();
  await assert.rejects(
    () =>
      toolCtx(deploy).publish({ entrypoint: "x", name: "bad", share: [{ scope: "not-a-scope", permission: "read" }] }),
    /invalid share target/,
  );
});

test("transferDeploymentOwner re-homes the app to the teammate: they own it, prior grants survive, the giver keeps reach", async () => {
  const { deploy, acl } = makeDeploy();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "handover",
  });
  await deploy.shareDeployment(d.id, scopeId("personal", "U3"), "read", { createdBy: "U1" });

  await deploy.transferDeploymentOwner("handover", scopeId("personal", "V1"), { callerId: "U1" });

  const after = (await deploy.listDeployments()).find((x) => x.id === d.id)!;
  assert.equal(after.ownerScopeId, scopeId("personal", "V1"), "the teammate is now the owner (home scope)");
  assert.equal(after.createdBy, "U1", "the immutable creator is untouched (provenance)");

  assert.equal((await deploy.reachDeployment("handover", "V1")).status, "ok");
  assert.equal((await deploy.reachDeployment("handover", "U3")).status, "ok", "prior grants are re-keyed, not dropped");
  assert.equal((await deploy.reachDeployment("handover", "U1")).status, "ok", "the giver isn't locked out");
  assert.equal((await deploy.reachDeployment("handover", "U9")).status, "denied");

  assert.equal((await acl.grantsFor(scopeId("personal", "U1"), `deployment:${d.id}`)).length, 0);

  await deploy.shareDeployment(d.id, scopeId("personal", "U4"), "read", { createdBy: "V1" });
  assert.equal((await deploy.reachDeployment("handover", "U4")).status, "ok");
  await assert.rejects(
    () => deploy.shareDeployment(d.id, scopeId("personal", "U5"), "read", { createdBy: "U1" }),
    /only the owner/,
  );
});

test("a manage grantee may redeploy but cannot make the owner's app public", async () => {
  const { deploy } = makeDeploy();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "managed-private",
  });
  await deploy.shareDeployment(d.id, scopeId("personal", "U2"), "write", { createdBy: "U1" });
  await assert.rejects(
    () =>
      deploy.deployOrUpdate({
        ownerScopeId: scopeId("personal", "U2"),
        createdBy: "U2",
        name: "managed-private",
        entrypoint: "x",
        files: [],
        public: true,
      }),
    /only the owner/,
  );
  assert.equal((await deploy.getDeployment(d.id))?.public, undefined);
});

test("transferDeploymentOwner is home authority — a write ('manage') grantee cannot give the app away", async () => {
  const { deploy } = makeDeploy();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "kept",
  });
  await deploy.shareDeployment(d.id, scopeId("personal", "U2"), "write", { createdBy: "U1" });
  assert.equal(await deploy.canManageDeployment(d.id, "U2"), true, "U2 can manage…");
  await assert.rejects(
    () => deploy.transferDeploymentOwner("kept", scopeId("personal", "U2"), { callerId: "U2" }),
    /only the owner/,
  );
  const after = (await deploy.listDeployments()).find((x) => x.id === d.id)!;
  assert.equal(after.ownerScopeId, scopeId("personal", "U1"), "…but not take ownership");
});

test("transferDeploymentOwner to the current home is a no-op", async () => {
  const { deploy, acl } = makeDeploy();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "same",
  });
  await deploy.transferDeploymentOwner("same", scopeId("personal", "U1"), { callerId: "U1" });
  const after = (await deploy.listDeployments()).find((x) => x.id === d.id)!;
  assert.equal(after.ownerScopeId, scopeId("personal", "U1"));
  assert.equal((await acl.list()).length, 0, "no self-grant sprayed by a no-op transfer");
});

test("deployment public access is explicit, owner-only, and reversible", async () => {
  const { app } = apiHarness();
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "public-toggle",
  });

  const initial = await callManage(getDeploymentShares, app, cap("U1"), "public-toggle", {});
  assert.equal(initial.status, 200);
  assert.equal(initial.body.public, false, "apps are private by default");

  const denied = await callShare(app, cap("U2"), "public-toggle", { public: true });
  assert.equal(denied.status, 403, "only the owner may make an app public");

  const enabled = await callShare(app, cap("U1"), "public-toggle", { public: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.public, true);
  assert.equal((await app.getDeployment("public-toggle"))?.public, true);

  const sharedWhilePublic = await callShare(app, cap("U1"), "public-toggle", {
    scope: "personal:U2",
    access: "view",
  });
  assert.equal(sharedWhilePublic.body.public, true, "person changes preserve and return general access");

  const disabled = await callShare(app, cap("U1"), "public-toggle", { public: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.public, false);
  assert.equal((await app.getDeployment("public-toggle"))?.public, undefined);
});

test("deployment permissions are visible only to the owner, including for managers", async () => {
  const { app } = apiHarness();
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "permissions",
  });
  await callShare(app, cap("U1"), "permissions", { scope: "personal:U2", access: "manage" });
  const owner = await callManage(getDeploymentShares, app, cap("U1"), "permissions", {});
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body.grantees, [{ scope: "personal:U2", permission: "write" }]);
  assert.equal((await callManage(getDeploymentShares, app, cap("U2"), "permissions", {})).status, 403);
  assert.equal((await callManage(getDeploymentShares, app, null, "permissions", {})).status, 403);
  assert.equal((await callManage(getDeploymentShares, app, cap("U1"), "missing", {})).status, 404);
  await callShare(app, cap("U1"), "permissions", { scope: "personal:U2", access: "none" });
  assert.deepEqual((await callManage(getDeploymentShares, app, cap("U1"), "permissions", {})).body.grantees, []);
});

test("app email grants normalize, dedupe, revoke, and reject external manage without changing the grant", async () => {
  const { app, deploy } = apiHarness();
  await app.deploy({ ownerScopeId: "personal:U1", createdBy: "U1", entrypoint: "x", files: [], name: "email-app" });
  for (const email of ["  Invitee@Example.com  ", "invitee@example.com"]) {
    const r = await callShare(app, cap("U1"), "email-app", { email });
    assert.equal(r.status, 200);
    assert.equal(r.body.target.scope, "personal:invitee@example.com");
  }
  const expected = [{ scope: "personal:invitee@example.com", permission: "read" }];
  assert.deepEqual(await deploy.deploymentGrantees("email-app"), expected);
  assert.equal((await deploy.reachDeployment("email-app", "invitee@example.com")).status, "ok");
  assert.equal((await deploy.reachDeployment("email-app", "other@example.com")).status, "denied");
  for (const body of [
    { email: "invitee@example.com", access: "manage" },
    { scope: "personal:invitee@example.com", access: "manage" },
    { email: "not an email" },
    { email: 123 },
    { email: "invitee@example.com", scope: "org" },
    { email: "invitee@example.com", recipient: "other" },
    { email: "invitee@example.com", public: true },
  ])
    assert.equal((await callShare(app, cap("U1"), "email-app", body)).status, 400);
  assert.equal((await callShare(app, cap("U2"), "email-app", { email: "other@example.com" })).status, 403);
  assert.deepEqual(await deploy.deploymentGrantees("email-app"), expected);
  assert.equal(
    (await callShare(app, cap("U1"), "email-app", { email: "INVITEE@example.com", access: "none" })).status,
    200,
  );
  assert.deepEqual(await deploy.deploymentGrantees("email-app"), []);
});

test("directory email recipients retain manage access", async () => {
  const { deploy } = makeDeploy(async (email) => email === "member@example.com");
  const d = await deploy.deploy({ ownerScopeId: "personal:U1", createdBy: "U1", entrypoint: "x", files: [] });
  await deploy.shareDeployment(d.id, "personal:Member@Example.com", "write", { createdBy: "U1" });
  assert.deepEqual(await deploy.deploymentGrantees(d.id), [
    { scope: "personal:member@example.com", permission: "write" },
  ]);
  assert.equal(await deploy.canManageDeployment(d.id, "member@example.com"), true);
});

test("exact email read grants admit app-only login and guest reach without membership or source access", async () => {
  const { deploy, acl } = makeDeploy();
  const identity = createIdentityService();
  const directory = createDirectoryStore();
  const app = createApp({ deploy, acl, identity, directory, auditLog: { record() {} } } as unknown as Parameters<
    typeof createApp
  >[0]);
  const d = await app.deploy({
    ownerScopeId: "personal:U1",
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "invite-test",
  });
  const email = "invitee@example.com";
  await identity.deactivate(email, "directory-sync");
  assert.equal(identity.classify(email).type, "guest");
  const allowed = async (email: string) => {
    let status: number | undefined;
    let body: unknown;
    const handle = authBrokerRoutes.find((r) => "path" in r && r.path.endsWith("email-allowed"))!.handle;
    await handle({
      app,
      deps: { identity, acl },
      url: new URL(`http://core/v1/auth/broker/email-allowed?email=${encodeURIComponent(email)}`),
      res: {
        writeHead(s: number) {
          status = s;
        },
        end(s: string) {
          body = JSON.parse(s);
        },
      },
    } as unknown as ApiCtx);
    assert.equal(status, 200);
    return body;
  };
  assert.deepEqual(await allowed(email), { allowed: false });
  await app.shareDeployment(d.id, `personal:${email}`, "read", { createdBy: "U1" });
  assert.deepEqual(await allowed(" Invitee@Example.com "), { allowed: true, appOnly: true });
  assert.deepEqual(await allowed("other@example.com"), { allowed: false });
  assert.equal(await app.effectiveDeploymentPermission(d, "Invitee@Example.com"), "read");
  assert.equal(await app.effectiveDeploymentPermission(d, "other@example.com"), null);
  assert.equal(await app.deploymentGitPermissionFor(d.id, email), null);
  assert.equal((await app.reachDeployment(d.id, email)).status, "ok");
  assert.equal(await app.directoryMember(email), null);
  assert.equal(identity.externalMember(email), undefined);
  assert.equal(identity.classify(email).type, "guest");
  await app.archiveDeployment(d.id);
  assert.deepEqual(await allowed(email), { allowed: false });
  await app.restoreDeployment(d.id, "U1");
  await identity.deactivate(email);
  assert.deepEqual(await allowed(email), { allowed: false });
  assert.equal(await app.effectiveDeploymentPermission(d, email), null);
  await identity.reactivate(email);
  await app.shareDeployment(d.id, `personal:${email}`, null, { createdBy: "U1" });
  assert.deepEqual(await allowed(email), { allowed: false });
  assert.equal(await app.effectiveDeploymentPermission(d, email), null);
  for (const grant of [
    { ref: `deployment:${d.id}`, granteeScopeId: `personal:${email}`, permission: "write" as const },
    { ref: "deployment:missing", granteeScopeId: `personal:${email}`, permission: "read" as const },
    { ref: `deployment:${d.id}`, granteeScopeId: "org:default-org" as const, permission: "read" as const },
  ])
    await acl.grant({ ownerScopeId: "personal:U1", grantedBy: "U1", ...grant });
  assert.deepEqual(
    await allowed(email),
    { allowed: false },
    "write, dangling and org grants do not admit an app-only login",
  );
});

test("uniform app share accepts exact emails and enforces view-only outside the directory", async () => {
  const { deploy, acl } = makeDeploy();
  const app = createApp({
    deploy,
    acl,
    identity: createIdentityService(),
    directory: createDirectoryStore(),
    auditLog: { record() {} },
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({ ownerScopeId: "personal:U1", createdBy: "U1", entrypoint: "x", files: [] });
  const control = createControlService(app);
  const r = await control.shareArtifact({ type: "deploy", id: d.id, email: "Invitee@Example.com" }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.target.scope, "personal:invitee@example.com");
  const blocked = await control.shareArtifact(
    { type: "deploy", id: d.id, email: "invitee@example.com", permission: "write" },
    cap("U1"),
  );
  assert.equal(blocked.ok, false);
  assert.deepEqual(await deploy.deploymentGrantees(d.id), [
    { scope: "personal:invitee@example.com", permission: "read" },
  ]);
  const moved = await control.shareArtifact(
    { type: "deploy", id: d.id, email: "invitee@example.com", move: true },
    cap("U1"),
  );
  assert.equal(moved.ok, false);
});

test("new email grants send an app-specific invitation once; re-adds and revocations send nothing", async () => {
  const { deploy, acl } = makeDeploy();
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const app = createApp({
    deploy,
    acl,
    identity: createIdentityService(),
    deployAppsDomain: "apps.example.com",
    inviteMailer: {
      async send(message: (typeof sent)[number]) {
        sent.push(message);
        return "message-id";
      },
    },
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({
    ownerScopeId: "personal:U1",
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "status-page",
  });
  await app.setDeploymentDisplayName(d.id, "Status <page>");
  const added = await callShare(app, cap("U1"), d.id, { email: "  Invitee@Example.com " });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.invitation, { emailSent: true, appUrl: "https://status-page.apps.example.com/" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "invitee@example.com");
  assert.equal(sent[0]!.subject, "You've been invited to Status <page>");
  assert.match(sent[0]!.text, /Sign in using this email address \(invitee@example.com\)/);
  assert.match(sent[0]!.text, /https:\/\/status-page\.apps\.example\.com\//);
  assert.doesNotMatch(sent[0]!.text, /single-use|token=/);
  assert.match(sent[0]!.html, /Status &lt;page&gt;/);
  const repeated = await Promise.all(
    ["invitee@example.com", "INVITEE@example.com"].map((email) => callShare(app, cap("U1"), d.id, { email })),
  );
  assert.ok(repeated.every((r) => r.body.invitation.alreadyShared && !r.body.invitation.emailSent));
  assert.equal(sent.length, 1);
  await callShare(app, cap("U1"), d.id, { email: "invitee@example.com", access: "none" });
  assert.equal(sent.length, 1);
  const addedConcurrently = await Promise.all(
    ["other@example.com", "OTHER@example.com"].map((email) => callShare(app, cap("U1"), d.id, { email })),
  );
  assert.equal(addedConcurrently.filter((r) => r.body.invitation.emailSent).length, 1);
  assert.equal(sent.length, 2);
});

test("failed invitation delivery leaves the grant and reports the failure and manual app link", async () => {
  for (const mailer of [
    undefined,
    {
      async send() {
        throw new Error("mail unavailable");
      },
    },
  ]) {
    const { deploy, acl } = makeDeploy();
    const app = createApp({
      deploy,
      acl,
      identity: createIdentityService(),
      deployAppsDomain: "apps.example.com",
      inviteMailer: mailer,
    } as unknown as Parameters<typeof createApp>[0]);
    const d = await app.deploy({
      ownerScopeId: "personal:U1",
      createdBy: "U1",
      entrypoint: "x",
      files: [],
      name: "status-page",
    });
    const added = await callShare(app, cap("U1"), d.id, { email: "invitee@example.com" });
    assert.equal(added.status, 200);
    assert.equal(added.body.invitation.emailSent, false);
    assert.match(added.body.invitation.emailProblem, mailer ? /mail unavailable/ : /not configured/);
    assert.equal(added.body.invitation.appUrl, "https://status-page.apps.example.com/");
    assert.deepEqual(await deploy.deploymentGrantees(d.id), [
      { scope: "personal:invitee@example.com", permission: "read" },
    ]);
  }
});

test("uniform app share uses the same invitation sender", async () => {
  const { deploy, acl } = makeDeploy();
  const sent: string[] = [];
  const app = createApp({
    deploy,
    acl,
    identity: createIdentityService(),
    directory: createDirectoryStore(),
    deployAppsDomain: "apps.example.com",
    inviteMailer: {
      async send(message: { to: string }) {
        sent.push(message.to);
        return "sent";
      },
    },
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({ ownerScopeId: "personal:U1", createdBy: "U1", entrypoint: "x", files: [] });
  const result = await createControlService(app).shareArtifact(
    { type: "deploy", id: d.id, email: "invitee@example.com" },
    cap("U1"),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.invitation?.emailSent, true);
  assert.deepEqual(sent, ["invitee@example.com"]);
});
