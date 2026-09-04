import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { fileArtifactId, type PutFileInput } from "../src/files/file-artifact-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres file-artifact-store tests";

const owner = scopeId("channel", "C1");
const other = scopeId("personal", "U9");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS file_artifacts CASCADE");
  await p.end();
});

function put(over: Partial<PutFileInput> = {}): PutFileInput {
  return {
    id: fileArtifactId("run-1", "out", 0),
    ownerScopeId: owner,
    createdBy: "U1",
    name: "flag.png",
    path: "artifacts/flag.png",
    mimetype: "image/png",
    data: PNG,
    direction: "out",
    createdInScope: owner,
    createdAt: 1000,
    ...over,
  };
}

test("pg put is an idempotent upsert by deterministic id (no dup, no byte re-store)", { skip }, async () => {
  const bytes = createMemoryDurableByteStore();
  let putCount = 0;
  const counting = {
    put: (s: never, o: never) => {
      putCount++;
      return bytes.put(s, o);
    },
    open: bytes.open,
    delete: bytes.delete,
  };
  const store = createPostgresFileArtifactStore(URL!, counting as never);

  const first = await store.put(put());
  assert.equal(first.created, true);
  const second = await store.put(put({ name: "renamed.png" }));
  assert.equal(second.created, false);
  assert.equal(second.artifact.name, "flag.png", "existing row returned unchanged");
  assert.equal(putCount, 1, "no byte re-store on requeue");
  assert.equal((await store.listOwnedByScopes([owner])).files.length, 1);
});

test("pg listOwnedByScopes: recency DESC, scope-filtered, keyset-paginated", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
  await store.put(put({ id: "b", path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
  await store.put(put({ id: "c", path: "p/c", data: Buffer.from("c"), createdAt: 300 }));
  await store.put(put({ id: "z", ownerScopeId: other, path: "p/z", data: Buffer.from("z"), createdAt: 999 }));

  assert.deepEqual(
    (await store.listOwnedByScopes([owner])).files.map((f) => f.id),
    ["c", "b", "a"],
  );
  const p1 = await store.listOwnedByScopes([owner], { limit: 2 });
  assert.deepEqual(
    p1.files.map((f) => f.id),
    ["c", "b"],
  );
  assert.ok(p1.nextCursor);
  const p2 = await store.listOwnedByScopes([owner], { limit: 2, cursor: p1.nextCursor! });
  assert.deepEqual(
    p2.files.map((f) => f.id),
    ["a"],
  );
  assert.equal(p2.nextCursor, undefined);
});

test("pg listOwnedByScopes: created-scope and enabled filters compose", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
  await store.put(put({ id: "b", ownerScopeId: other, path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
  await store.put(put({ id: "c", path: "p/c", data: Buffer.from("c"), createdInScope: other, createdAt: 300 }));
  await store.put(put({ id: "d", ownerScopeId: other, path: "p/d", data: Buffer.from("d"), createdAt: 400 }));
  await store.setEnabled("d", false);

  const visible = await store.listOwnedByScopes([owner, other], { createdInScope: owner });
  assert.deepEqual(
    visible.files.map((f) => f.id),
    ["b", "a"],
  );
  const all = await store.listOwnedByScopes([owner, other], { createdInScope: owner, includeDisabled: true });
  assert.deepEqual(
    all.files.map((f) => f.id),
    ["d", "b", "a"],
  );
});

test("pg scoped file pages have a matching enabled recency index", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.listOwnedByScopes([owner], { createdInScope: owner });
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const result = await raw.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'file_artifacts_scope_created'");
    assert.match(
      result.rows[0]?.indexdef ?? "",
      /\(created_in_scope, created_at DESC, id DESC\).*WHERE \(enabled = true\)/,
    );
  } finally {
    await raw.end();
  }
});

test("pg resolveByOwnerPaths returns the shared set; disabled excluded", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.put(put({ id: "r1", path: "p/r1", data: Buffer.from("1") }));
  await store.put(put({ id: "r2", path: "p/r2", data: Buffer.from("2") }));

  assert.deepEqual(
    (await store.resolveByOwnerPaths([{ ownerScopeId: owner, path: "p/r1" }])).map((f) => f.id),
    ["r1"],
  );
  await store.setEnabled("r1", false);
  assert.equal((await store.resolveByOwnerPaths([{ ownerScopeId: owner, path: "p/r1" }])).length, 0);
});

test("pg open round-trips bytes; delete removes the ROW only", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.put(put({ id: "o1", direction: "out", path: "p/o1", data: PNG }));
  await store.put(put({ id: "i1", direction: "in", path: "p/i1", data: PNG }));

  const opened = await store.open("o1");
  assert.ok(opened);
  const chunks: Buffer[] = [];
  for await (const c of opened!.stream) chunks.push(c as Buffer);
  assert.deepEqual(Buffer.concat(chunks), PNG);

  await store.delete("o1");
  assert.equal(await store.get("o1"), null, "row gone");
  assert.ok(await store.open("i1"), "shared bytes survive (no inline byte delete)");
});

test("pg rows survive across store instances (no per-process cache to diverge)", { skip }, async () => {
  const writer = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await writer.put(put({ id: "across", path: "p/across", data: Buffer.from("x"), createdAt: 5 }));
  const reader = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  assert.ok(await reader.get("across"));
});
