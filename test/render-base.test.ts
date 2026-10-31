import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createRenderBase, type RenderBase, type StoredRenderBase } from "../src/sandbox/render-base.ts";
import { parseRenderSandboxImage } from "../src/sandbox/render-limits.ts";
import { createFakeRender } from "./support/fake-render.ts";
import { testMap } from "./support/test-database.ts";

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const REF_A = `ghcr.io/acme/sandbox-base:${SHA_A}@${DIGEST_A}`;
const REF_B = `ghcr.io/acme/sandbox-base:${SHA_B}@${DIGEST_B}`;

function setup(t: TestContext) {
  const fake = createFakeRender();
  t.after(() => fake.cleanup());
  fake.publishImage(`ghcr.io/acme/sandbox-base:${SHA_A}`, DIGEST_A);
  fake.publishImage(`ghcr.io/acme/sandbox-base:${SHA_B}`, DIGEST_B);
  const store = testMap<StoredRenderBase>();
  const errors: string[] = [];
  const make = (image: string) =>
    createRenderBase({
      client: fake.client,
      store,
      image,
      pollMs: 5,
      waitMs: 2_000,
      prepareMs: 5,
      retryMs: 5,
      onError: (error) => errors.push(error.message),
    });
  const prepareUntil = async (base: RenderBase, done: () => Promise<boolean> | boolean) => {
    const stop = new AbortController();
    const preparing = base.prepare(stop.signal);
    while (!(await done())) await new Promise((resolve) => setTimeout(resolve, 5));
    stop.abort();
    await preparing;
  };
  return { fake, store, errors, make, prepareUntil };
}

const prepare = (base: RenderBase) => base.prepare(new AbortController().signal);

function countWrites<T>(map: DurableMap<T>) {
  const writes: string[] = [];
  for (const method of ["put", "putIfAbsent", "merge", "delete", "mutateMany"] as const) {
    const original = map[method].bind(map) as (...args: unknown[]) => unknown;
    (map as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      writes.push(method);
      return original(...args);
    };
  }
  return writes;
}

test("parseRenderSandboxImage requires a tag and a digest", () => {
  assert.deepEqual(parseRenderSandboxImage(REF_A), {
    ref: REF_A,
    source: `ghcr.io/acme/sandbox-base:${SHA_A}`,
    digest: DIGEST_A,
    name: "qm-sandbox-base-0123456",
  });
  assert.equal(parseRenderSandboxImage(`localhost:5000/base:v1@${DIGEST_A}`).source, "localhost:5000/base:v1");
  for (const ref of [
    `ghcr.io/acme/sandbox-base@${DIGEST_A}`,
    `localhost:5000/base@${DIGEST_A}`,
    `ghcr.io/acme/sandbox-base:${SHA_A}`,
    `ghcr.io/acme/sandbox-base:${SHA_A}@sha256:short`,
  ])
    assert.throws(() => parseRenderSandboxImage(ref), /must be <repository>:<tag>@sha256:<digest>/);
});

test("Render base imports the tagged image, snapshots a builder, and does nothing once ready", async (t) => {
  const { fake, store, errors, make } = setup(t);
  const base = make(REF_A);
  await prepare(base);
  assert.deepEqual(errors, []);
  assert.deepEqual(fake.imports, [{ source: `ghcr.io/acme/sandbox-base:${SHA_A}`, name: "qm-sandbox-base-0123456" }]);
  const record = (await store.get(DIGEST_A))!;
  assert.equal(record.ref, REF_A);
  assert.equal(record.snapshot?.status, "available");
  assert.ok(record.readyAtMs);
  const builder = fake.snapshotSource(record.snapshot!.id)!.sandboxId;
  assert.ok(fake.terminated.includes(builder));
  assert.deepEqual(await base.ready(), { ref: REF_A, snapshotId: record.snapshot!.id });

  const writes = countWrites(store);
  const calls = { imports: fake.imports.length, creates: fake.createdFrom.length };
  await prepare(make(REF_A));
  assert.deepEqual(writes, []);
  assert.deepEqual({ imports: fake.imports.length, creates: fake.createdFrom.length }, calls);
});

test("Render base refuses an image whose tag no longer points at the pinned digest", async (t) => {
  const { fake, store, errors, make, prepareUntil } = setup(t);
  fake.publishImage(`ghcr.io/acme/sandbox-base:${SHA_A}`, DIGEST_B);
  const base = make(REF_A);
  await prepareUntil(base, async () => Boolean((await store.get(DIGEST_A))?.error));
  assert.match((await store.get(DIGEST_A))!.error!, /not the pinned/);
  assert.ok(errors.length >= 1);
  assert.deepEqual(fake.createdFrom, []);
  await assert.rejects(base.ready(), /is not ready: Render imported/);
});

test("Render base keeps a golden snapshot that is still being created and rebuilds one that failed", async (t) => {
  const { fake, store, errors, make, prepareUntil } = setup(t);
  await prepare(make(REF_A));
  const staged = (await store.get(DIGEST_A))!.snapshot!;
  await store.merge(DIGEST_A, { snapshot: { ...staged, status: "creating" }, readyAtMs: undefined });
  fake.snapshots.get(staged.id)!.status = "creating";
  const creates = fake.createdFrom.length;
  await prepareUntil(make(REF_A), () => true);
  assert.equal((await store.get(DIGEST_A))!.snapshot?.id, staged.id);
  assert.ok(fake.snapshots.has(staged.id));
  fake.snapshots.get(staged.id)!.status = "available";
  await prepare(make(REF_A));
  const finished = (await store.get(DIGEST_A))!;
  assert.equal(finished.snapshot?.id, staged.id);
  assert.equal(finished.snapshot?.status, "available");
  assert.ok(finished.readyAtMs);
  assert.equal(fake.createdFrom.length, creates);

  await store.merge(DIGEST_A, { readyAtMs: undefined });
  fake.snapshots.get(staged.id)!.status = "failed";
  await prepare(make(REF_A));
  const rebuilt = (await store.get(DIGEST_A))!;
  assert.ok(fake.deleted.includes(staged.id));
  assert.equal(errors.length, 1);
  assert.notEqual(rebuilt.snapshot?.id, staged.id);
  assert.ok(rebuilt.readyAtMs);
  assert.equal(rebuilt.error, undefined);
  assert.equal(fake.images.size, 1);
});

test("Render base keeps serving the previous golden until a new release's golden is ready", async (t) => {
  const { fake, store, make } = setup(t);
  await prepare(make(REF_A));
  const goldenA = (await store.get(DIGEST_A))!.snapshot!.id;
  const releaseB = make(REF_B);
  assert.deepEqual(await releaseB.ready(), { ref: REF_A, snapshotId: goldenA });

  await prepare(releaseB);
  const goldenB = (await store.get(DIGEST_B))!.snapshot!.id;
  assert.deepEqual(await releaseB.ready(), { ref: REF_B, snapshotId: goldenB });
  assert.deepEqual(await make(REF_A).ready(), { ref: REF_A, snapshotId: goldenA });
  assert.ok(fake.snapshots.has(goldenA));
});

test("Render base waits for the first golden snapshot", async (t) => {
  const { make } = setup(t);
  const base = make(REF_A);
  const waiting = base.ready();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await prepare(base);
  assert.equal((await waiting).ref, REF_A);
});

test("Render base gives up waiting when no golden snapshot appears", async (t) => {
  const { fake } = setup(t);
  const base = createRenderBase({
    client: fake.client,
    store: testMap<StoredRenderBase>(),
    image: REF_A,
    pollMs: 5,
    waitMs: 30,
  });
  await assert.rejects(base.ready(), /is still being prepared after/);
});

test("Render base reports a failed import, retries it, and clears the error once a retry succeeds", async (t) => {
  const { fake, store, errors, make } = setup(t);
  fake.failImport("manifest unknown");
  const preparing = prepare(make(REF_A));
  while (errors.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(errors[0]!, /failed: manifest unknown/);
  fake.failImport();
  await preparing;
  assert.ok(fake.images.size >= 3);
  const record = (await store.get(DIGEST_A))!;
  assert.equal(record.error, undefined);
  assert.ok(record.readyAtMs);
});

test("Render base polls an import that is still running and stops when the core stops", async (t) => {
  const { fake, store, make, prepareUntil } = setup(t);
  fake.slowImports();
  const preparing = prepare(make(REF_A));
  while (fake.imports.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(fake.createdFrom, []);
  assert.equal(fake.images.size, 1);
  fake.slowImports(false);
  await preparing;
  assert.ok((await store.get(DIGEST_A))!.readyAtMs);
  assert.equal(fake.images.size, 1);

  fake.slowImports();
  await prepareUntil(make(REF_B), () => fake.images.size === 2);
  assert.equal((await store.get(DIGEST_B))!.readyAtMs, undefined);
});
