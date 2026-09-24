import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignSystems, type DesignSystemSelection } from "../src/design-system/design-systems.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId, personalScope } from "../src/types.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "design-system-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const selections = createMemoryMap<DesignSystemSelection>();
  const store = createDeployStore({ git: { repoRoot: join(dir, "git") } });
  let rejectApply = false;
  const deploy = createDeployService({
    deployStore: store,
    deployDir: join(dir, "apps"),
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    provider: {
      profile: { managedScaleToZero: true },
      apply: async () => {
        if (rejectApply) throw new Error("failed build");
        return { host: "127.0.0.1", port: 5000 };
      },
      destroy: async () => {},
    },
  });
  const denied = new Set<string>();
  const org = scopeId("org", "acme");
  const deps = {
    selections,
    store,
    deploy,
    orgScope: org,
    lock: createNoopAdvisoryLock(),
    canRead: async (id: string, actor: string) => {
      const d = await store.get(id);
      return (
        !!d &&
        !denied.has(actor) &&
        (d.ownerScopeId === org ||
          d.createdBy === actor ||
          (await deploy.deploymentGrantees(id)).some((g) => g.scope === org))
      );
    },
  };
  return {
    service: createDesignSystems(deps),
    deps,
    store,
    deploy,
    org,
    denied,
    failBuild: () => {
      rejectApply = true;
    },
    allowBuild: () => {
      rejectApply = false;
    },
  };
}

test("org and personal design apps persist separately and compose in order", async (t) => {
  const f = await fixture(t);
  const org = await f.service.create("org", "alice");
  const personal = await f.service.create("personal", "alice");
  assert.ok(org && personal);
  assert.notEqual(org.id, personal.id);
  const fresh = createDesignSystems(f.deps);
  const context = await fresh.context("alice", personalScope("alice"));
  assert.deepEqual(
    context.references.map((r) => r.kind),
    ["org", "personal"],
  );
  assert.ok(context.prompt.includes(`design://${personal.id}/1/`));
  const overlay = await fresh.read("alice", context.references, `design://${personal.id}/1/DESIGN.md`);
  assert.match(overlay.content!, /No overrides yet/);
  assert.equal(overlay.shared, true);
  assert.deepEqual(await f.deploy.deploymentGrantees(org.id), [{ scope: personalScope("alice"), permission: "write" }]);
  assert.deepEqual(
    (await fresh.context("bob", personalScope("bob"))).references.map((r) => r.id),
    [org.id],
  );
  assert.deepEqual(
    (await fresh.context("alice", scopeId("channel", "shared"))).references.map((r) => r.id),
    [org.id],
  );
  await fresh.select("personal", "alice", null);
  assert.equal((await fresh.state("alice")).personal, null);
  assert.equal((await fresh.state("alice")).org?.id, org.id);
});

test("a private app cannot become the org default and inaccessible apps cannot be selected", async (t) => {
  const f = await fixture(t);
  const personal = await f.service.create("personal", "alice");
  assert.ok(personal);
  await assert.rejects(f.service.select("org", "alice", personal.id), /Share the app/);
  await assert.rejects(f.service.select("personal", "bob", personal.id), /access/);
  assert.equal((await f.service.state("bob")).choices.length, 0);
});

test("archiving and access revocation remove references and block previously captured source reads", async (t) => {
  const f = await fixture(t);
  const org = await f.service.create("org", "alice");
  assert.ok(org);
  const context = await f.service.context("alice", personalScope("alice"));
  f.denied.add("alice");
  await assert.rejects(
    f.service.read("alice", context.references, `design://${org.id}/1/DESIGN.md`),
    /no longer accessible/,
  );
  assert.equal((await f.service.context("alice", personalScope("alice"))).references.length, 0);
  assert.equal((await f.service.state("alice")).orgUnavailable, true);
  f.denied.clear();
  await f.deploy.archiveDeployment(org.id);
  assert.equal((await f.service.context("alice", personalScope("alice"))).references.length, 0);
});

test("failed publishes keep the applied design version and captured references stay immutable", async (t) => {
  const f = await fixture(t);
  const org = await f.service.create("org", "alice");
  assert.ok(org);
  const context = await f.service.context("alice", personalScope("alice"));
  f.failBuild();
  await assert.rejects(
    f.deploy.redeploy(org.id, {
      entrypoint: "node server.mjs",
      files: [{ path: "DESIGN.md", data: "unpublished replacement" }],
    }),
    /failed build/,
  );
  assert.equal((await f.service.state("alice")).org?.version, 1);
  assert.doesNotMatch(
    (await f.service.read("alice", context.references, `design://${org.id}/1/DESIGN.md`)).content!,
    /unpublished replacement/,
  );
  await assert.rejects(f.service.read("alice", context.references, `design://${org.id}/2/DESIGN.md`), /not supplied/);
  assert.equal((await f.service.read("alice", context.references, `design://${org.id}/1/../server.mjs`)).content, null);
});

test("source storage failure preserves reference metadata for unrelated turns", async (t) => {
  const f = await fixture(t);
  await f.service.create("org", "alice");
  const service = createDesignSystems({
    ...f.deps,
    store: {
      ...f.store,
      treeOf: async () => {
        throw new Error("storage unavailable");
      },
    },
  });
  const context = await service.context("alice", personalScope("alice"));
  assert.equal(context.references.length, 1);
  assert.match(context.prompt, /sourceUnavailable/);
});

test("starter creation retries one app and never overwrites an existing selection", async (t) => {
  const f = await fixture(t);
  f.failBuild();
  await assert.rejects(f.service.create("org", "alice"), /failed build/);
  const failed = await f.store.list();
  assert.equal(failed.length, 1);
  assert.equal((await f.service.state("alice")).choices.length, 0);
  f.allowBuild();
  const recovered = await f.service.create("org", "alice");
  assert.equal(recovered?.id, failed[0]!.id);
  assert.equal((await f.store.list()).length, 1);
  await f.service.select("org", "alice", null);
  assert.deepEqual(await f.service.create("org", "alice"), recovered);
});

test("design URI reads use captured source without provisioning a sandbox and reject writes", async (t) => {
  const { createToolContext } = await import("../src/tools/primitives.ts");
  const f = await fixture(t);
  const design = await f.service.create("org", "alice");
  assert.ok(design);
  const context = await f.service.context("alice", personalScope("alice"));
  const tc = createToolContext({
    sandbox: {} as never,
    provision: async () => {
      throw new Error("must not provision");
    },
    layers: [{ scopeId: personalScope("alice"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "alice",
    readDesignSource: (uri) => f.service.read("alice", context.references, uri),
  });
  const uri = `design://${design.id}/1/DESIGN.md`;
  assert.equal((await tc.read(uri)).shared, true);
  await assert.rejects(tc.write(uri, "replace"), /read-only/);
});
