import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { collectBytes } from "../../src/util/bytes.ts";
import { ByteSourceTooLargeError, type DurableByteStore } from "../../src/files/durable-byte-store.ts";
import {
  BlobHashMismatchError,
  BlobTooLargeError,
  type BlobTransferStore,
} from "../../src/persistence/blob-transfer.ts";

export function createMemoryDurableByteStore(): DurableByteStore {
  const blobs = new Map<string, Buffer>();
  return {
    async put(source, opts) {
      const { data, sha256 } = await collectBytes(source, {
        ...(opts?.maxBytes != null ? { maxBytes: opts.maxBytes } : {}),
        tooLarge: () => new ByteSourceTooLargeError(),
      });
      const blobKey = `files/${sha256}`;
      if (!blobs.has(blobKey)) blobs.set(blobKey, data);
      return { blobKey, sizeBytes: data.length, sha256 };
    },
    async open(blobKey, range) {
      const hit = blobs.get(blobKey);
      if (!hit) return null;
      return { sizeBytes: hit.length, stream: Readable.from(range ? hit.subarray(range.start, range.end + 1) : hit) };
    },
    async delete(blobKey) {
      blobs.delete(blobKey);
    },
  };
}

export function createMemoryBlobTransferStore(): BlobTransferStore {
  const blobs = new Map<string, { data: Buffer; at: number }>();
  return {
    async put(source, opts) {
      const { data, sizeBytes, sha256 } = await collectBytes(source, {
        ...(opts?.maxBytes != null ? { maxBytes: opts.maxBytes } : {}),
        tooLarge: () => new BlobTooLargeError(),
      });
      if (opts?.expectedSha256 && opts.expectedSha256 !== sha256) throw new BlobHashMismatchError();
      const blobId = randomBytes(16).toString("hex");
      blobs.set(blobId, { data, at: Date.now() });
      return { blobId, sizeBytes, sha256 };
    },
    async open(blobId) {
      const hit = blobs.get(blobId);
      if (!hit) return null;
      return { sizeBytes: hit.data.length, stream: Readable.from(hit.data) };
    },
    async delete(blobId) {
      blobs.delete(blobId);
    },
    async sweep(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      for (const [id, v] of blobs) {
        if (v.at <= cutoff) {
          blobs.delete(id);
          removed++;
        }
      }
      return removed;
    },
  };
}
