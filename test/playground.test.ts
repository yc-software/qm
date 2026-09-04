import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import {
  createPlaygroundArtifact,
  normalizePlaygroundTitle,
  validatePlaygroundHtml,
} from "../src/playgrounds/playground.ts";

const HTML = "<!doctype html><button id='go'>Go</button><script>go.onclick=()=>go.textContent='Done'</script>";

test("playgrounds are stored unchanged as ordinary scoped file artifacts", async () => {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const result = await createPlaygroundArtifact(store, {
    title: "  Tiny   demo  ",
    html: HTML,
    ownerScopeId: "personal:alice",
    createdBy: "alice",
  });

  assert.equal(result.kind, "playground");
  assert.equal(result.title, "Tiny demo");
  const opened = await store.open(result.artifactId);
  assert.equal(opened?.artifact.mimetype, "text/html");
  assert.equal(opened?.artifact.ownerScopeId, "personal:alice");
  assert.equal(await opened?.stream.toArray().then((chunks) => Buffer.concat(chunks).toString()), HTML);
});

test("validation enforces storage limits without parsing or rewriting HTML", () => {
  assert.throws(() => validatePlaygroundHtml("  "), /empty/);
  assert.doesNotThrow(() => validatePlaygroundHtml("<script>document.body.append('ready')</script>"));
  assert.equal(normalizePlaygroundTitle(" "), "Playground");
  // The 80-char cut lands mid-emoji here; it must not leave a lone surrogate behind,
  // because the title is persisted as JSON.
  const clipped = normalizePlaygroundTitle(`${"a".repeat(78)}\u{1F680}tail`);
  assert.equal(clipped, `${"a".repeat(78)}…`);
});
