import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";

const scope = scopeId("personal", "U1");

test("file names that merely start with '..' are ordinary files", async () => {
  const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-dotdot-")));
  await ws.write(scope, "..notes.md", "hi");
  await ws.write(scope, "dir/..hidden", "x");
  assert.equal(await ws.read(scope, "..notes.md"), "hi");
  assert.equal(await ws.read(scope, "dir/..hidden"), "x");
});

test("real parent-directory escapes are still rejected", async () => {
  const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-dotdot-")));
  for (const bad of ["..", "../x", "a/../../x", "/etc/passwd"]) {
    await assert.rejects(ws.write(scope, bad, "no"), /escapes workspace/, bad);
  }
});
