import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { loadTapeImage } from "../src/core/orchestrator.ts";
import type { FileArtifact, FileArtifactStore } from "../src/files/file-artifact-store.ts";

const artifact = (sizeBytes: number): FileArtifact =>
  ({
    id: "a1",
    ownerScopeId: "channel:C1",
    createdBy: "U1",
    name: "qa.png",
    path: "inbox/qa.png",
    mimetype: "image/png",
    sizeBytes,
    blobKey: "blob",
    sha256: "hash",
    direction: "in",
    source: "live",
    createdAt: 1,
    updatedAt: 1,
    enabled: true,
  }) as FileArtifact;

test("tape image loader flags over-budget metadata as eviction without opening a body stream", async () => {
  let opens = 0;
  const store = {
    get: async () => artifact(3),
    open: async () => {
      opens++;
      return null;
    },
  } as unknown as FileArtifactStore;
  assert.equal(await loadTapeImage(store, "a1", 2, () => true), "over-budget");
  assert.equal(opens, 0);
});

test("tape image loader destroys a body stream when opened metadata changed", async () => {
  const stream = Readable.from(Buffer.from("abc"));
  let destroyed = false;
  const originalDestroy = stream.destroy.bind(stream);
  stream.destroy = ((error?: Error) => {
    destroyed = true;
    return originalDestroy(error);
  }) as typeof stream.destroy;
  const store = {
    get: async () => artifact(2),
    open: async () => ({ artifact: artifact(3), sizeBytes: 3, stream }),
  } as unknown as FileArtifactStore;
  assert.equal(await loadTapeImage(store, "a1", 2, () => true), null);
  assert.equal(destroyed, true);
});

test("tape image loader enforces current artifact authorization before opening bytes", async () => {
  let opens = 0;
  const store = {
    get: async () => artifact(2),
    open: async () => {
      opens++;
      return null;
    },
  } as unknown as FileArtifactStore;
  assert.equal(await loadTapeImage(store, "a1", 2, () => false), null);
  assert.equal(opens, 0);
});
