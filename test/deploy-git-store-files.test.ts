import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeployGitStore } from "../src/deploy/deploy-git-store.ts";

test("filesIn reads binary, empty and duplicate blobs in one batch and reports missing ones", async () => {
  const store = createDeployGitStore({ repoRoot: mkdtempSync(join(tmpdir(), "git-store-files-")) });
  const binary = new Uint8Array([0, 10, 255, 10, 0, 49, 32, 98, 108, 111, 98, 10]);
  const files = [
    { path: "a.bin", data: binary },
    { path: "b.bin", data: binary },
    { path: "empty.txt", data: new Uint8Array() },
    { path: "text.txt", data: Buffer.from("hello\n") },
  ];
  const commit = await store.commit({ deploymentId: "d1", version: 1, files });
  const entries = await store.treeOf("d1", commit);
  const read = await store.filesIn("d1", entries);
  assert.deepEqual(
    read.map((f) => [f.path, Buffer.from(f.data).toString("hex")]),
    files.map((f) => [f.path, Buffer.from(f.data).toString("hex")]),
  );
  assert.deepEqual(await store.filesIn("d1", []), []);
  await assert.rejects(
    store.filesIn("d1", [{ ...entries[0]!, sha: "0".repeat(40), path: "gone.txt" }]),
    (err: Error) => err.message === `missing blob ${"0".repeat(40)} for gone.txt`,
  );
});
