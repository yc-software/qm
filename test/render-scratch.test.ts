import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import {
  createRenderSandbox,
  type StoredRenderSandbox,
  type StoredRenderCleanup,
  type StoredRenderScratch,
} from "../src/sandbox/render-sandbox.ts";
import { SandboxProvisionCleanupError, type SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createFakeRender } from "./support/fake-render.ts";
import { testMap, testAdvisoryLock } from "./support/test-database.ts";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "render-scratch-"));
  const fake = createFakeRender();
  t.after(() => {
    try {
      assert.equal(fake.snapshots.size, 0);
      assert.deepEqual(fake.deleted, []);
    } finally {
      fake.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const workspace = createLocalWorkspaceStore(dir);
  const store = testMap<StoredRenderSandbox>();
  const scratchStore = testMap<StoredRenderScratch>();
  const cleanupStore = testMap<StoredRenderCleanup>();
  const advisoryLock = testAdvisoryLock();
  const errors: string[] = [];
  const ref = `ghcr.io/acme/sandbox-base:${"0".repeat(40)}@sha256:${"a".repeat(64)}`;
  const golden = { ref, snapshotId: fake.seedGolden(ref) };
  const make = (backing = scratchStore, lock = advisoryLock) =>
    createRenderSandbox(workspace, {
      client: fake.client,
      base: { ready: async () => golden, prepare: async () => {} },
      store,
      scratchStore: backing,
      cleanupStore,
      advisoryLock: lock,
      onError: ({ code }) => errors.push(code),
    });
  return { make, fake, store, scratchStore, errors };
}

const options = { scratch: { key: "turn" } };

test("Render preserves an allocation error when no disposable sandbox was created", async (t) => {
  const { make, fake, scratchStore } = setup(t);
  const failure = new Error("allocation refused");
  t.mock.method(fake.client, "create", async () => {
    throw failure;
  });
  await assert.rejects(make().provision([], options), (error) => error === failure);
  assert.deepEqual(await scratchStore.entries(), []);
  assert.deepEqual(fake.terminated, []);
});

test("Render keeps a disposable sandbox until its last local handle is released", async (t) => {
  const { make, fake, scratchStore, store } = setup(t);
  const sandbox = make();
  const a = await sandbox.provision([], options);
  const b = await sandbox.provision([], options);
  assert.equal(a.providerSandboxId, "sbx-1");
  assert.equal(b.providerSandboxId, a.providerSandboxId);
  assert.equal(fake.sandboxes.size, 1);
  assert.deepEqual(await store.entries(), []);
  await sandbox.teardown(a);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "running");
  assert.equal((await scratchStore.entries()).length, 1);
  await sandbox.teardown(b);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
  assert.deepEqual(await scratchStore.entries(), []);
});

test("Another Render core can execute and destroy a saved disposable handle", async (t) => {
  const { make, fake, scratchStore } = setup(t);
  const handle = await make().provision([], options);
  const other = make();
  assert.equal((await other.run(handle, "echo retained")).stdout, "retained\n");
  await other.teardown(handle, { destroy: true });
  await other.teardown(handle, { destroy: true });
  assert.deepEqual(fake.terminated, [handle.providerSandboxId]);
  assert.deepEqual(await scratchStore.entries(), []);
});

test("Another Render core cannot reuse an active disposable allocation", async (t) => {
  const { make, fake } = setup(t);
  const results = await Promise.allSettled([make().provision([], options), make().provision([], options)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.reason.message, /in use by another core/);
  assert.equal(fake.sandboxes.size, 1);
  assert.deepEqual(fake.terminated, []);
});

test("A Render core cannot reuse a replacement through its old local allocation", async (t) => {
  const { make, fake } = setup(t);
  const owner = make();
  const old = await owner.provision([], options);
  const other = make();
  await other.teardown(old, { destroy: true });
  const current = await other.provision([], options);
  const before = fake.commands.length;
  await assert.rejects(owner.provision([], options), /in use by another core/);
  assert.equal(fake.commands.length, before);
  await owner.teardown(old, { destroy: true });
  assert.equal(fake.sandboxes.get(current.providerSandboxId!)?.status, "running");
});

test("Render removes a disposable allocation after preparation fails", async (t) => {
  const { make, fake, scratchStore } = setup(t);
  t.mock.method(fake.client, "runScript", async () => ({ stdout: "", stderr: "preparation refused", exitCode: 1 }));
  await assert.rejects(make().provision([], options), /preparation refused/);
  assert.deepEqual(fake.terminated, ["sbx-1"]);
  assert.deepEqual(await scratchStore.entries(), []);
});

test("Render retries failed preparation cleanup from another core", async (t) => {
  const { make, fake, scratchStore, errors } = setup(t);
  fake.failTerminate(new Error("termination refused"));
  t.mock.method(fake.client, "runScript", async () => ({ stdout: "", stderr: "preparation refused", exitCode: 1 }));
  let handle: SandboxHandle | undefined;
  await assert.rejects(make().provision([], options), (error) => {
    assert.ok(error instanceof SandboxProvisionCleanupError);
    handle = error.handle;
    return true;
  });
  assert.equal(handle!.providerSandboxId, "sbx-1");
  assert.equal((await scratchStore.get(handle!.id))?.cleanupPending, true);
  const other = make();
  assert.deepEqual(await other.reapDeepIdle!(0), { reaped: 0 });
  assert.ok(errors.includes("scratch_cleanup_failed"));
  assert.equal((await scratchStore.entries()).length, 1);
  fake.failTerminate();
  assert.deepEqual(await other.reapDeepIdle!(0), { reaped: 1 });
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
  assert.deepEqual(await scratchStore.entries(), []);
});

test("Render can retry disposable teardown with a saved handle", async (t) => {
  const { make, fake, scratchStore } = setup(t);
  const handle = await make().provision([], options);
  fake.failTerminate(new Error("termination refused"));
  await assert.rejects(make().teardown(handle, { destroy: true }), /termination refused/);
  assert.equal((await scratchStore.get(handle.id))?.cleanupPending, true);
  fake.failTerminate();
  await make().teardown(handle, { destroy: true });
  assert.deepEqual(fake.terminated, [handle.providerSandboxId]);
  assert.deepEqual(await scratchStore.entries(), []);
});

test("Render deletes an allocation when its durable record cannot be saved", async (t) => {
  const { make, fake, scratchStore } = setup(t);
  const put = scratchStore.put;
  const failure = new Error("record unavailable");
  let refuse = true;
  t.mock.method(scratchStore, "put", async (id: string, value: StoredRenderScratch) => {
    if (refuse) {
      refuse = false;
      throw failure;
    }
    await put(id, value);
  });
  await assert.rejects(make().provision([], options), (error) => error === failure);
  assert.deepEqual(fake.terminated, ["sbx-1"]);
  assert.deepEqual(await scratchStore.entries(), []);
});

test("Render retains cleanup when both the initial record and termination fail", async (t) => {
  const { make, fake, scratchStore } = setup(t);
  const put = scratchStore.put;
  let refusePut = true;
  t.mock.method(scratchStore, "put", async (id: string, value: StoredRenderScratch) => {
    if (refusePut) {
      refusePut = false;
      throw new Error("record unavailable");
    }
    await put(id, value);
  });
  fake.failTerminate(new Error("termination refused"));
  await assert.rejects(make().provision([], options), SandboxProvisionCleanupError);
  assert.equal((await scratchStore.entries())[0]?.[1].cleanupPending, true);
  fake.failTerminate();
  assert.deepEqual(await make().reapDeepIdle!(0), { reaped: 1 });
  assert.deepEqual(await scratchStore.entries(), []);
});

test("Render retries record removal after the native sandbox was terminated", async (t) => {
  const { make, fake, scratchStore } = setup(t);
  const handle = await make().provision([], options);
  const remove = scratchStore.delete;
  let refuse = true;
  t.mock.method(scratchStore, "delete", async (id: string) => {
    if (refuse) {
      refuse = false;
      throw new Error("record removal refused");
    }
    await remove(id);
  });
  await assert.rejects(make().teardown(handle, { destroy: true }), /record removal refused/);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
  assert.equal((await scratchStore.get(handle.id))?.cleanupPending, true);
  assert.deepEqual(await make().reapDeepIdle!(0), { reaped: 1 });
  assert.deepEqual(await scratchStore.entries(), []);
});

test("Render sweeps expired disposable allocations and keeps active allocations", async (t) => {
  const { make, fake, scratchStore } = setup(t);
  const sandbox = make();
  const expired = await sandbox.provision([], options);
  const active = await sandbox.provision([], { scratch: { key: "active" } });
  await scratchStore.merge(expired.id, { expiresAtMs: Date.now() - 1 });
  assert.deepEqual(await make().reapDeepIdle!(0), { reaped: 1 });
  assert.equal(fake.sandboxes.get(expired.providerSandboxId!)?.status, "terminated");
  assert.equal(fake.sandboxes.get(active.providerSandboxId!)?.status, "running");
  assert.equal((await scratchStore.entries()).length, 1);
});

test("Render does not execute or delete a new allocation through an old handle", async (t) => {
  const { make, fake } = setup(t);
  const sandbox = make();
  const old = await sandbox.provision([], options);
  await sandbox.teardown(old, { destroy: true });
  const current = await sandbox.provision([], options);
  assert.notEqual(current.providerSandboxId, old.providerSandboxId);
  await assert.rejects(sandbox.run(old, "touch unexpected"), /has been released/);
  await sandbox.teardown(old, { destroy: true });
  assert.deepEqual(fake.terminated, [old.providerSandboxId]);
  assert.equal(fake.sandboxes.get(current.providerSandboxId!)?.status, "running");
});

test("Render serializes disposable cleanup across cores", async (t) => {
  const { make, fake, scratchStore } = setup(t);
  const handle = await make().provision([], options);
  await Promise.all([make().teardown(handle, { destroy: true }), make().teardown(handle, { destroy: true })]);
  assert.deepEqual(fake.terminated, [handle.providerSandboxId]);
  assert.deepEqual(await scratchStore.entries(), []);
});

for (const cleanup of ["teardown", "expiry sweep"] as const) {
  test(`Render completes a disposable file import before ${cleanup}`, { timeout: 10_000 }, async (t) => {
    const { make, fake, scratchStore } = setup(t);
    const sandbox = make();
    const handle = await sandbox.provision([], options);
    const uploading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = fake.client.writeFileBytes;
    t.mock.method(fake.client, "writeFileBytes", async (id: string, path: string, data: Uint8Array) => {
      uploading.resolve();
      await release.promise;
      await write(id, path, data);
    });
    const pending = sandbox.importFiles!(handle, [{ path: "latest", data: Buffer.from("completed import") }]);
    await uploading.promise;
    if (cleanup === "expiry sweep") await scratchStore.merge(handle.id, { expiresAtMs: Date.now() - 1 });
    const other = make();
    const disposal = cleanup === "teardown" ? other.teardown(handle, { destroy: true }) : other.reapDeepIdle!(0);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((await scratchStore.get(handle.id))?.cleanupPending, undefined);
      assert.deepEqual(fake.terminated, []);
    } finally {
      release.resolve();
      const results = await Promise.allSettled([pending, disposal]);
      for (const result of results) assert.equal(result.status, "fulfilled");
    }
    assert.deepEqual(fake.terminated, [handle.providerSandboxId]);
    assert.deepEqual(await scratchStore.entries(), []);
  });
}

test("A failed Render initialization cannot later delete a replacement allocation", async (t) => {
  const { make, fake } = setup(t);
  const run = fake.client.runScript;
  let refuse = true;
  fake.failTerminate(new Error("termination refused"));
  t.mock.method(fake.client, "runScript", async (id: string, script: string, timeout: number) =>
    refuse ? { stdout: "", stderr: "preparation refused", exitCode: 1 } : run(id, script, timeout),
  );
  const sandbox = make();
  let old: SandboxHandle | undefined;
  await assert.rejects(sandbox.provision([], options), (error) => {
    assert.ok(error instanceof SandboxProvisionCleanupError);
    old = error.handle;
    return true;
  });
  assert.equal(old!.providerSandboxId, "sbx-1");
  refuse = false;
  fake.failTerminate();
  const current = await sandbox.provision([], options);
  await make().teardown(old!, { destroy: true });
  assert.equal(fake.sandboxes.get(current.providerSandboxId!)?.status, "running");
});

test(
  "Render recovers disposable cleanup after Postgres connections are replaced",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const { make, fake } = setup(t);
    const first = createPostgresMapFactory(process.env.DATABASE_URL!);
    const second = createPostgresMapFactory(process.env.DATABASE_URL!);
    const table = `render_scratch_test_${randomUUID().replaceAll("-", "")}`;
    const initial = first.map<StoredRenderScratch>(table);
    const recovered = second.map<StoredRenderScratch>(table);
    fake.failTerminate(new Error("termination refused"));
    try {
      const owner = make(initial, createPostgresAdvisoryLock(first.pool));
      const handle = await owner.provision([], options);
      await assert.rejects(owner.teardown(handle, { destroy: true }), /termination refused/);
      await first.pool.close();
      assert.equal((await recovered.get(handle.id))?.cleanupPending, true);
      const applied = await second.pool.q("SELECT id FROM qm_schema_migrations WHERE id=$1", [
        `durable-map/${table}/0001`,
      ]);
      assert.equal(applied.length, 1);
      fake.failTerminate();
      assert.deepEqual(await make(recovered, createPostgresAdvisoryLock(second.pool)).reapDeepIdle!(0), { reaped: 1 });
      assert.equal(fake.sandboxes.get(handle.providerSandboxId!)?.status, "terminated");
      assert.deepEqual(await recovered.entries(), []);
    } finally {
      await second.pool.q(`DROP TABLE IF EXISTS ${table}`);
      await second.pool.q("DELETE FROM durable_map_versions WHERE tbl=$1", [table]);
      await second.pool.q("DELETE FROM qm_schema_migrations WHERE id=$1", [`durable-map/${table}/0001`]);
      await Promise.all([first.pool.close(), second.pool.close()]);
    }
  },
);
