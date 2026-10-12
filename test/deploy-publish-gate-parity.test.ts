import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore, type AclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore, type DirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createCanReadScope, createCanWriteScope } from "../src/resolution/scope-membership.ts";
import { scopeId } from "../src/types.ts";

const CH = "CBUILT";
const CH_OTHER = "CSHARED";

async function setup(opts: { withResolver: boolean } = { withResolver: true }) {
  const deployStore = createDeployStore({ git: { repoRoot: mkdtempSync(join(tmpdir(), "parity-repo-")) } });
  const acl: AclStore = createAclStore();
  const directory: DirectoryStore = createDirectoryStore();
  const identity = createIdentityService();
  await directory.replaceChannels(
    [
      { channelId: CH, name: "built", isPrivate: true },
      { channelId: CH_OTHER, name: "shared", isPrivate: true },
    ],
    [
      { channelId: CH, principalId: "U1" },
      { channelId: CH, principalId: "U2" },
      { channelId: CH_OTHER, principalId: "U2" },
      { channelId: CH_OTHER, principalId: "U3" },
    ],
  );
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 19996 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "parity-deploy-")),
    ...(opts.withResolver
      ? {
          canReadScope: createCanReadScope({ directory, identity }),
          canWriteScope: createCanWriteScope({ directory, identity }),
        }
      : {}),
  });
  const d = await deploy.deployOrUpdate({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    files: [{ path: "server.js", data: "console.log('v1')" }],
    name: "channel-app",
    createdInScope: scopeId("channel", CH),
  });
  return { deploy, acl, d, directory };
}

test("canManage: a channel-creation member may manage from a DM/other context", async () => {
  const { deploy, d } = await setup();
  const renamed = await deploy.deployOrUpdate({
    ownerScopeId: scopeId("personal", "U2"),
    createdBy: "U2",
    renameFrom: d.name ?? d.id,
    name: "renamed-from-dm",
    createdInScope: scopeId("personal", "U2"),
  });
  assert.equal(renamed.name, "renamed-from-dm");
});

test("canManage: a member of a shared-into channel still cannot manage from any context", async () => {
  const { deploy, acl, d } = await setup();
  await acl.grant({
    ownerScopeId: scopeId("personal", "U1"),
    ref: `deployment:${d.id}`,
    granteeScopeId: scopeId("channel", CH_OTHER),
    permission: "read",
    grantedBy: "U1",
  });
  await assert.rejects(
    deploy.deployOrUpdate({
      ownerScopeId: scopeId("personal", "U3"),
      createdBy: "U3",
      renameFrom: d.name ?? d.id,
      name: "renamed-by-outsider",
      createdInScope: scopeId("personal", "U3"),
    }),
    /not authorized to manage/i,
  );
});

test("canManage: without the resolver, a channel member from a DM context is denied (fallback)", async () => {
  const { deploy, d } = await setup({ withResolver: false });
  await assert.rejects(
    deploy.deployOrUpdate({
      ownerScopeId: scopeId("personal", "U2"),
      createdBy: "U2",
      renameFrom: d.name ?? d.id,
      name: "should-fail",
      createdInScope: scopeId("personal", "U2"),
    }),
    /not authorized to manage/i,
  );
});

test("canManage: the creator may still manage from a DM context", async () => {
  const { deploy, d } = await setup();
  const renamed = await deploy.deployOrUpdate({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    renameFrom: d.name ?? d.id,
    name: "renamed-by-creator-dm",
    createdInScope: scopeId("personal", "U1"),
  });
  assert.equal(renamed.name, "renamed-by-creator-dm");
});

test("new channel apps grant read access only to authenticated current channel members", async () => {
  const { deploy, d, directory } = await setup();
  assert.equal(d.ownerScopeId, scopeId("personal", "U1"));
  assert.notEqual(d.public, true);
  assert.deepEqual(await deploy.deploymentGrantees(d.id), [{ scope: scopeId("channel", CH), permission: "read" }]);
  assert.equal((await deploy.reachDeployment(d.id, "U2")).status, "ok");
  assert.equal((await deploy.reachDeployment(d.id, "U3")).status, "denied");
  assert.equal((await deploy.reachDeployment(d.id, "")).status, "denied");
  await directory.replaceChannels(
    [{ channelId: CH, name: "built", isPrivate: true }],
    [{ channelId: CH, principalId: "U1" }],
  );
  assert.equal((await deploy.reachDeployment(d.id, "U2")).status, "denied");
});

test("direct deployment creation also grants channel read access", async () => {
  const { deploy } = await setup();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    createdInScope: scopeId("channel", CH),
  });
  assert.deepEqual(await deploy.deploymentGrantees(d.id), [{ scope: scopeId("channel", CH), permission: "read" }]);
  assert.equal((await deploy.reachDeployment(d.id, "U2")).status, "ok");
});

test("DM apps stay private when republished or renamed in a channel", async () => {
  const { deploy } = await setup();
  const input = {
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "dm-app",
  };
  const d = await deploy.deployOrUpdate({ ...input, createdInScope: scopeId("personal", "U1") });
  assert.deepEqual(await deploy.deploymentGrantees(d.id), []);
  assert.equal((await deploy.reachDeployment(d.id, "U2")).status, "denied");
  await deploy.deployOrUpdate({ ...input, createdInScope: scopeId("channel", CH) });
  await deploy.deployOrUpdate({
    ...input,
    name: "renamed-dm-app",
    renameFrom: "dm-app",
    createdInScope: scopeId("channel", CH_OTHER),
  });
  assert.deepEqual(await deploy.deploymentGrantees(d.id), []);
  assert.equal((await deploy.reachDeployment(d.id, "U2")).status, "denied");
});

test("republishing channel apps neither widens their audience nor restores revoked grants", async () => {
  const { deploy, acl, d } = await setup();
  const input = { ownerScopeId: d.ownerScopeId, createdBy: "U1", name: d.name!, entrypoint: "x", files: [] };
  await deploy.deployOrUpdate({ ...input, createdInScope: scopeId("channel", CH_OTHER) });
  assert.deepEqual(await deploy.deploymentGrantees(d.id), [{ scope: scopeId("channel", CH), permission: "read" }]);
  assert.equal((await deploy.reachDeployment(d.id, "U3")).status, "denied");
  await acl.revoke(d.ownerScopeId, `deployment:${d.id}`, scopeId("channel", CH), "U1");
  await deploy.deployOrUpdate({ ...input, createdInScope: scopeId("channel", CH) });
  assert.deepEqual(await deploy.deploymentGrantees(d.id), []);
  assert.equal((await deploy.reachDeployment(d.id, "U2")).status, "denied");
});

test("public-channel defaults follow existing channel visibility without anonymous access", async () => {
  const { deploy, d, directory } = await setup();
  await directory.replaceChannels(
    [{ channelId: CH, name: "built", isPrivate: false }],
    [{ channelId: CH, principalId: "U1" }],
  );
  assert.equal((await deploy.reachDeployment(d.id, "U3")).status, "ok");
  assert.equal((await deploy.reachDeployment(d.id, "")).status, "denied");
  assert.notEqual((await deploy.getDeployment(d.id))?.public, true);
});
