import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { createGcsDurableByteStore } from "../src/files/durable-byte-store.ts";
import { collectBlob, createGcsBlobTransferStore } from "../src/persistence/blob-transfer.ts";

class MemoryFile {
  data?: Buffer;
  updated = new Date().toISOString();

  async save(data: Buffer): Promise<void> {
    this.data = Buffer.from(data);
    this.updated = new Date().toISOString();
  }

  createReadStream(): Readable {
    return Readable.from(this.data ?? Buffer.alloc(0));
  }

  createWriteStream(): Writable {
    const chunks: Buffer[] = [];
    const save = (data: Buffer) => {
      this.data = data;
      this.updated = new Date().toISOString();
    };
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final(callback) {
        save(Buffer.concat(chunks));
        callback();
      },
    });
  }

  async getMetadata(): Promise<Array<{ size: string; updated: string }>> {
    if (!this.data) {
      const error = new Error("missing") as Error & { code: number };
      error.code = 404;
      throw error;
    }
    return [{ size: String(this.data.length), updated: this.updated }];
  }

  async delete(): Promise<void> {
    this.data = undefined;
  }
}

class MemoryBucket {
  files = new Map<string, MemoryFile>();

  file(name: string): MemoryFile {
    const current = this.files.get(name) ?? new MemoryFile();
    this.files.set(name, current);
    return current;
  }

  async getFiles({ prefix }: { prefix: string }): Promise<MemoryFile[][]> {
    return [
      [...this.files.entries()].filter(([name, file]) => name.startsWith(prefix) && file.data).map(([, file]) => file),
    ];
  }
}

test("GCS durable byte store preserves content-addressed files", async () => {
  const bucket = new MemoryBucket();
  const store = createGcsDurableByteStore({ bucket: "test", _bucket: bucket as never });
  const saved = await store.put(Buffer.from("simplelend"));
  assert.equal(saved.sha256, createHash("sha256").update("simplelend").digest("hex"));
  const opened = await store.open(saved.blobKey);
  assert.ok(opened);
  assert.equal((await collectBlob(opened.stream)).toString(), "simplelend");
  await store.delete(saved.blobKey);
  assert.equal(await store.open(saved.blobKey), null);
});

test("GCS transfer store verifies hashes and leaves lifecycle policy to the operator", async () => {
  const bucket = new MemoryBucket();
  const store = createGcsBlobTransferStore({ bucket: "test", prefix: "qm/", _bucket: bucket as never });
  const expectedSha256 = createHash("sha256").update("evidence").digest("hex");
  const saved = await store.put(Buffer.from("evidence"), { expectedSha256 });
  const opened = await store.open(saved.blobId);
  assert.ok(opened);
  assert.equal((await collectBlob(opened.stream)).toString(), "evidence");
  assert.equal(store.ensureExpiry, undefined);
  await store.delete(saved.blobId);
  assert.equal(await store.open(saved.blobId), null);
});

test("GCS transfer store catches asynchronous upload errors and cleans up", async () => {
  let deleted = false;
  const failingFile = {
    createWriteStream() {
      const stream = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      setTimeout(() => stream.emit("error", new Error("upload failed")), 5);
      return stream;
    },
    createReadStream: () => Readable.from([]),
    getMetadata: async () => [{ size: "0" }],
    delete: async () => {
      deleted = true;
    },
  };
  const store = createGcsBlobTransferStore({
    bucket: "test",
    _bucket: {
      file: () => failingFile,
      getFiles: async () => [[]],
    },
  });

  async function* slowSource() {
    yield Buffer.alloc(1024);
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield Buffer.alloc(1024);
  }

  await assert.rejects(store.put(slowSource()), /upload failed/);
  assert.equal(deleted, true);
});
