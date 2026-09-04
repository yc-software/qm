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
      { channelId: CH, name: "built" },
      { channelId: CH_OTHER, name: "shared" },
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
  return { deploy, acl, d };
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
