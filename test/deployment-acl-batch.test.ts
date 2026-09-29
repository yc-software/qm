import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createApp, type App, type AppDeps } from "../src/api/app.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { Grant } from "../src/types.ts";

async function fixture() {
  const rows: Deployment[] = Array.from({ length: 64 }, (_, i) => ({
    id: `deployment-${String(i).padStart(2, "0")}`,
    ownerScopeId: "personal:owner",
    createdBy: "owner",
    createdInScope: "org:default-org",
    displayName: "zanzibar deployment",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions: [],
  }));
  const grant = (index: number, extra: Partial<Grant> = {}): Grant => ({
    ownerScopeId: "personal:owner",
    ref: `deployment:${rows[index]!.id}`,
    granteeScopeId: "personal:viewer",
    permission: "read",
    grantedBy: "owner",
    ...extra,
  });
  const grants = [
    grant(0, { ownerScopeId: "personal:other" }),
    grant(1, { ref: "deployment:unrelated" }),
    grant(2, { ref: rows[2]!.id }),
    grant(62, { granteeScopeId: "channel:C1" }),
    grant(63, { permission: "write" }),
  ];
  const reads = { all: 0, list: 0, grantsFor: 0 };
  const acl = createAclStore({
    async all() {
      reads.all++;
      await setImmediate();
      return structuredClone(grants);
    },
    put: async () => assert.fail("Unexpected grant mutation"),
    remove: async () => assert.fail("Unexpected grant mutation"),
    replaceForResourceIfCurrent: async () => assert.fail("Unexpected grant mutation"),
  });
  const list = acl.list;
  acl.list = () => {
    reads.list++;
    return list();
  };
  const grantsFor = acl.grantsFor;
  acl.grantsFor = (...args) => {
    reads.grantsFor++;
    return grantsFor(...args);
  };
  const directory = createDirectoryStore();
  await directory.replaceChannels(
    [{ channelId: "C1", name: "private", isPrivate: true }],
    [{ channelId: "C1", principalId: "viewer" }],
  );
  const identity = createIdentityService();
  const app = createApp({
    acl,
    identity,
    directory,
    sessions: createMemorySessionStore(),
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    deploy: {
      listDeployments: async () => rows,
      getDeployment: async (id: string) => rows.find((row) => row.id === id) ?? null,
    },
    skills: { list: async () => [] },
    crons: { list: async () => [] },
    webhooks: { list: async () => [] },
  } as unknown as AppDeps);
  return { app, acl, rows, grants, reads, directory, identity };
}

const routes: Array<{ name: string; read: (app: App) => Promise<Array<{ id: string }>>; otherGrantReads: number }> = [
  { name: "deployment list", read: (app) => app.listDeploymentsForViewer("viewer"), otherGrantReads: 0 },
  {
    name: "scope resources",
    read: async (app) => (await app.listScopeResources("viewer", "org:default-org"))?.deployments ?? [],
    otherGrantReads: 1,
  },
  {
    name: "resource search",
    read: async (app) => {
      const result = await app.searchResources("viewer", "zanzibar");
      assert.deepEqual(result.failed, []);
      return result.hits.filter((hit) => hit.kind === "deploys");
    },
    otherGrantReads: 0,
  },
];

for (const route of routes) {
  test(`${route.name} shares one grant load across candidates and sees membership and grant revocation`, async () => {
    const { app, rows, grants, reads, directory, identity } = await fixture();
    const visible = [rows[62]!.id, rows[63]!.id];
    assert.deepEqual(
      (await route.read(app)).map((row) => row.id),
      visible,
    );
    assert.deepEqual(reads, { all: 1 + route.otherGrantReads, list: 1, grantsFor: 0 });
    assert.deepEqual(
      (await route.read(app)).map((row) => row.id),
      visible,
    );
    assert.deepEqual(reads, { all: 2 * (1 + route.otherGrantReads), list: 2, grantsFor: 0 });
    await directory.replaceChannels([{ channelId: "C1", name: "private", isPrivate: true }], []);
    assert.deepEqual(
      (await route.read(app)).map((row) => row.id),
      [rows[63]!.id],
    );
    grants.splice(4, 1);
    assert.deepEqual(await route.read(app), []);
    grants.push({
      ownerScopeId: "personal:owner",
      ref: `deployment:${rows[63]!.id}`,
      granteeScopeId: "personal:viewer",
      permission: "write",
      grantedBy: "owner",
    });
    await identity.deactivate("viewer");
    assert.deepEqual(await route.read(app), []);
  });

  test(`${route.name} skips the grant index for empty and owner-only results`, async () => {
    const { app, acl, rows, reads } = await fixture();
    acl.list = () => assert.fail("Owner and empty results must not load the grant index");
    for (const row of rows) {
      row.ownerScopeId = "personal:viewer";
      row.createdBy = "viewer";
    }
    assert.equal((await route.read(app)).length, route.name === "resource search" ? 8 : rows.length);
    rows.length = 0;
    assert.deepEqual(await route.read(app), []);
    assert.equal(reads.grantsFor, 0);
  });

  test(`${route.name} shares failed grant reads, retains owner access and retries next request`, async () => {
    const { app, acl, rows, reads } = await fixture();
    rows[0]!.ownerScopeId = "personal:viewer";
    rows[0]!.createdBy = "viewer";
    const list = acl.list;
    for (const failure of [
      () => {
        throw new Error("Unavailable grant store");
      },
      () => Promise.reject(new Error("Unavailable grant store")),
    ]) {
      let attempts = 0;
      acl.list = () => {
        attempts++;
        return failure();
      };
      assert.deepEqual(
        (await route.read(app)).map((row) => row.id),
        [rows[0]!.id],
      );
      assert.equal(attempts, 1);
    }
    acl.list = list;
    assert.deepEqual(
      (await route.read(app)).map((row) => row.id),
      [rows[0]!.id, rows[62]!.id, rows[63]!.id],
    );
    assert.equal(reads.list, 1);
    assert.equal(reads.grantsFor, 0);
  });
}

test("batch permissions preserve read/write distinctions and leave detail and Git authorization fresh", async () => {
  const { app, rows, grants, reads } = await fixture();
  assert.deepEqual(
    (await app.listDeploymentsForViewer("viewer")).map((row) => [row.id, row.permission]),
    [
      [rows[62]!.id, "read"],
      [rows[63]!.id, "write"],
    ],
  );
  assert.equal((await app.getDeploymentForViewer(rows[62]!.id, "viewer"))?.permission, "read");
  assert.equal(await app.authorizesDeploymentGitAccess(rows[62]!.id, "viewer", "write"), false);
  assert.equal(await app.authorizesDeploymentGitAccess(rows[63]!.id, "viewer", "write"), true);
  grants.length = 0;
  assert.equal(await app.deploymentGitPermissionFor(rows[63]!.id, "viewer"), null);
  assert.equal(await app.authorizesDeploymentGitAccess(rows[63]!.id, "viewer", "read"), false);
  assert.equal(await app.getDeploymentForViewer(rows[63]!.id, "viewer"), null);
  assert.equal(reads.list, 1);
  assert.equal(reads.grantsFor, 6);
  assert.deepEqual(await app.listDeploymentsForViewer("viewer"), []);
  assert.equal(reads.list, 2);
});
