import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryDurableByteStore,
  createLocalDurableByteStore,
  ByteSourceTooLargeError,
  type DurableByteStore,
} from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore, fileArtifactId, type PutFileInput } from "../src/files/file-artifact-store.ts";
import { scopeId } from "../src/types.ts";

const owner = scopeId("channel", "C1");
const other = scopeId("personal", "U9");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x7f]);

async function drain(
  store: { open(id: string): Promise<{ stream: NodeJS.ReadableStream } | null> },
  id: string,
): Promise<Buffer> {
  const opened = await store.open(id);
  assert.ok(opened, "expected openable bytes");
  const chunks: Buffer[] = [];
  for await (const c of opened!.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function put(over: Partial<PutFileInput> = {}): PutFileInput {
  return {
    id: fileArtifactId("run-1", "out", 0),
    ownerScopeId: owner,
    createdBy: "U1",
    name: "pirate_flag.png",
    path: "artifacts/flag.png",
    mimetype: "image/png",
    data: PNG,
    direction: "out",
    createdInScope: owner,
    createdAt: 1000,
    ...over,
  };
}

test("fileArtifactId is deterministic per (seed, direction, index) and varies otherwise", () => {
  assert.equal(fileArtifactId("run-1", "out", 0), fileArtifactId("run-1", "out", 0));
  assert.notEqual(fileArtifactId("run-1", "out", 0), fileArtifactId("run-1", "out", 1));
  assert.notEqual(fileArtifactId("run-1", "out", 0), fileArtifactId("run-1", "in", 0));
  assert.notEqual(fileArtifactId("run-1", "out", 0), fileArtifactId("run-2", "out", 0));
});

test("DurableByteStore (memory) round-trips binary intact and content-addresses (dedup)", async () => {
  const bytes = createMemoryDurableByteStore();
  const a = await bytes.put(PNG);
  assert.equal(a.blobKey, `files/${a.sha256}`);
  assert.equal(a.sizeBytes, PNG.length);
  const b = await bytes.put(PNG);
  assert.equal(b.blobKey, a.blobKey);
  const back = await drain(bytes as DurableByteStore as never, a.blobKey);
  assert.deepEqual(back, PNG, "binary must survive the store byte-for-byte");
});

test("DurableByteStore (local-fs) round-trips binary intact across a fresh store instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docstore-"));
  try {
    const w = createLocalDurableByteStore(dir);
    const { blobKey } = await w.put(PNG);
    const r = createLocalDurableByteStore(dir);
    const back = await drain(r as never, blobKey);
    assert.deepEqual(back, PNG);
    const again = await w.put(PNG);
    assert.equal(again.blobKey, blobKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DurableByteStore (local-fs) accepts concurrent identical writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docstore-"));
  try {
    const bytes = createLocalDurableByteStore(dir);
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024, 7)]);
    const results = await Promise.all(Array.from({ length: 8 }, () => bytes.put(big)));
    for (const r of results) assert.equal(r.blobKey, results[0]!.blobKey);
    assert.deepEqual(await drain(bytes as never, results[0]!.blobKey), big);
    const leftovers = (await readdir(join(dir, "files"))).filter((name) => name.endsWith(".part"));
    assert.deepEqual(leftovers, [], "no orphaned partial files survive the race");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DurableByteStore enforces maxBytes mid-stream", async () => {
  const bytes = createMemoryDurableByteStore();
  await assert.rejects(bytes.put(Buffer.alloc(1000), { maxBytes: 10 }), ByteSourceTooLargeError);
});

test("DurableByteStore.open returns null for an absent or malformed key", async () => {
  const bytes = createMemoryDurableByteStore();
  assert.equal(await bytes.open("files/" + "0".repeat(64)), null);
  assert.equal(await bytes.open("not-a-key"), null);
});

test("put: deterministic id makes a requeue a no-op upsert (no dup, no byte re-store)", async () => {
  const bytes = createMemoryDurableByteStore();
  let putCount = 0;
  const counting: DurableByteStore = {
    put: (s, o) => {
      putCount++;
      return bytes.put(s, o);
    },
    open: (k) => bytes.open(k),
    delete: (k) => bytes.delete(k),
  };
  const store = createMemoryFileArtifactStore(counting);

  const first = await store.put(put());
  assert.equal(first.created, true);
  const second = await store.put(put({ name: "ignored-rename.png" }));
  assert.equal(second.created, false);
  assert.equal(second.artifact.name, "pirate_flag.png", "existing row returned unchanged");
  assert.equal(putCount, 1, "no byte re-store on requeue");

  const page = await store.listOwnedByScopes([owner]);
  assert.equal(page.files.length, 1, "no duplicate row");
});

test("put + open round-trips binary through the artifact store", async () => {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const { artifact } = await store.put(put());
  assert.equal(artifact.mimetype, "image/png");
  assert.equal(artifact.sizeBytes, PNG.length);
  assert.equal(artifact.blobKey, `files/${artifact.sha256}`);
  const back = await drain(store, artifact.id);
  assert.deepEqual(back, PNG);
});

test("listOwnedByScopes: recency DESC, scope-filtered, keyset-paginated", async () => {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
  await store.put(put({ id: "b", path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
  await store.put(put({ id: "c", path: "p/c", data: Buffer.from("c"), createdAt: 300 }));
  await store.put(put({ id: "z", ownerScopeId: other, path: "p/z", data: Buffer.from("z"), createdAt: 999 }));

  const all = await store.listOwnedByScopes([owner]);
  assert.deepEqual(
    all.files.map((f) => f.id),
    ["c", "b", "a"],
    "newest first, other-owner excluded",
  );

  const p1 = await store.listOwnedByScopes([owner], { limit: 2 });
  assert.deepEqual(
    p1.files.map((f) => f.id),
    ["c", "b"],
  );
  assert.ok(p1.nextCursor, "expected a next cursor");
  const p2 = await store.listOwnedByScopes([owner], { limit: 2, cursor: p1.nextCursor! });
  assert.deepEqual(
    p2.files.map((f) => f.id),
    ["a"],
  );
  assert.equal(p2.nextCursor, undefined, "last page has no cursor");
});

test("resolveByOwnerPaths returns the SHARED set by (owner, path); disabled excluded", async () => {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a") }));
  await store.put(put({ id: "b", path: "p/b", data: Buffer.from("b") }));

  const hit = await store.resolveByOwnerPaths([{ ownerScopeId: owner, path: "p/a" }]);
  assert.deepEqual(
    hit.map((f) => f.id),
    ["a"],
  );

  await store.setEnabled("a", false);
  assert.equal(
    (await store.resolveByOwnerPaths([{ ownerScopeId: owner, path: "p/a" }])).length,
    0,
    "disabled excluded",
  );
  assert.equal(await store.get("a"), null, "get hides disabled by default");
  assert.ok(await store.get("a", { includeDisabled: true }), "get can surface disabled");
});

test("delete removes the ROW only — bytes shared with another row stay openable", async () => {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const { artifact: out } = await store.put(put({ id: "out", direction: "out", path: "p/out", data: PNG }));
  const { artifact: inb } = await store.put(put({ id: "in", direction: "in", path: "p/in", data: PNG }));
  assert.equal(out.blobKey, inb.blobKey, "identical bytes dedup to one blob");

  await store.delete("out");
  assert.equal(await store.get("out"), null, "row gone");
  const back = await drain(store, "in");
  assert.deepEqual(back, PNG, "the surviving row's bytes are intact (no inline byte delete)");
});
