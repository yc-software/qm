import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ingestInbound, materializeArtifact } from "../src/core/attachments.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { collectBlob, createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

function fixture() {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const transfer = createMemoryBlobTransferStore();
  const register = { store, ownerScopeId: "personal:U1" as const, createdBy: "U1", seed: "run" };
  const upload = async (name: string, text: string) => {
    const blob = await transfer.put(Buffer.from(text));
    return { name, mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId };
  };
  return { store, transfer, register, upload };
}

test("retry after image filtering keeps each artifact's identity, stored name and bytes", async () => {
  const { store, transfer, register, upload } = fixture();
  const first = { ...(await upload("same.txt", "first")), sourceId: "F1" };
  const second = { ...(await upload("same.txt", "second")), sourceId: "F2" };
  const original = await ingestInbound([first, second], transfer, register);
  const retry = await ingestInbound([second], transfer, register);
  assert.deepEqual(retry.metas, [original.metas[1]]);
  const opened = await store.open(retry.metas[0]!.artifactId!);
  assert.equal((await collectBlob(opened!.stream)).toString(), "second");
  assert.equal((await store.listOwnedByScopes([register.ownerScopeId])).files.length, 2);
});

test("a cancelled stream closes without blocking another conversation's ingestion", async () => {
  const { transfer, register, upload } = fixture();
  const hung = new Readable({ read() {} });
  const controller = new AbortController();
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const pending = ingestInbound(
    [{ name: "hung.bin", mimetype: "application/octet-stream", sizeBytes: 6_000_000, blobId: "hung" }],
    {
      ...transfer,
      open: async () => {
        opened();
        return { stream: hung, sizeBytes: 6_000_000 };
      },
    },
    register,
    undefined,
    controller.signal,
  );
  await ready;
  const independent = await ingestInbound([await upload("ok.txt", "ok")], transfer, { ...register, seed: "other" });
  assert.equal(independent.metas.length, 1);
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped|abort/i);
  assert.equal(hung.destroyed, true);
});

test("large intake streams to the artifact store, and oversized Auto content is withheld", async () => {
  const { store, transfer, register } = fixture();
  const size = 11_000_000;
  const blob = await transfer.put(Buffer.alloc(size, 97));
  const attachment = { name: "large.txt", mimetype: "text/plain", sizeBytes: size, blobId: blob.blobId };
  const put = store.put.bind(store);
  let streamed = false;
  store.put = async (input) => {
    streamed = input.data instanceof Readable;
    return put(input);
  };
  const accepted = await ingestInbound([attachment], transfer, register);
  assert.equal(streamed, true);
  assert.equal(accepted.metas[0]!.sizeBytes, size);
  const screened = await ingestInbound([attachment], transfer, { ...register, seed: "auto" }, async () => ({
    decision: "auto",
  }));
  assert.deepEqual(screened.metas, []);
  assert.match(screened.blocked[0]!, /security-screen limit/);
});

test("lazy materialization streams the authorized durable artifact and cleans its transfer blob", async () => {
  const { store, transfer, register, upload } = fixture();
  const result = await ingestInbound([await upload("notes.txt", "durable")], transfer, register);
  const artifact = await store.get(result.metas[0]!.artifactId!);
  assert.ok(artifact);
  let stagedBlob = "";
  const sandbox = {
    stageIn: async (_handle: unknown, path: string, blobId: string) => {
      assert.equal(path, ".agent-turn/test/notes.txt");
      stagedBlob = blobId;
      const opened = await transfer.open(blobId);
      assert.equal((await collectBlob(opened!.stream)).toString(), "durable");
    },
    writeFileBytes: async () => {
      assert.fail("streaming provider must not receive a whole-file buffer");
    },
  } as unknown as Sandbox;
  await materializeArtifact(
    store,
    transfer,
    sandbox,
    { id: "box", rootDir: "/workspace" },
    artifact,
    ".agent-turn/test/notes.txt",
  );
  assert.equal(await transfer.open(stagedBlob), null);
  await assert.rejects(
    materializeArtifact(
      store,
      transfer,
      sandbox,
      { id: "box", rootDir: "/workspace" },
      { ...artifact, ownerScopeId: "personal:other" },
      "notes.txt",
    ),
    /authorized reference/,
  );
});

test("Auto accepts large binary uploads but cannot evade text screening with a binary MIME", async () => {
  for (const [name, bytes, accepted] of [
    ["large.bin", Buffer.alloc(9_000_000), true],
    ["large.bin", Buffer.alloc(9_000_000, 97), false],
    ["large.txt", Buffer.alloc(9_000_000), false],
  ] as const) {
    const { transfer, register } = fixture();
    const blob = await transfer.put(bytes);
    const result = await ingestInbound(
      [{ name, mimetype: "application/octet-stream", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
      transfer,
      register,
      async () => ({ decision: "auto" }),
    );
    assert.equal(result.metas.length, accepted ? 1 : 0);
    assert.equal(result.blocked.length, accepted ? 0 : 1);
  }
});

test("surface source IDs cannot alias different immutable image uploads", async () => {
  const { transfer, store, register, upload } = fixture();
  const first = { ...(await upload("first.png", "first-image")), mimetype: "image/png", sourceId: "same-source" };
  const second = { ...(await upload("second.png", "second-image")), mimetype: "image/png", sourceId: "same-source" };
  const result = await ingestInbound([first, second], transfer, register);
  assert.equal(result.images.length, 2);
  assert.notEqual(result.images[0]!.artifactId, result.images[1]!.artifactId);
  for (const image of result.images) {
    const opened = await store.open(image.artifactId!);
    assert.deepEqual(await collectBlob(opened!.stream), Buffer.from(image.dataBase64, "base64"));
  }
});
