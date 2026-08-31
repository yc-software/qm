import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAttestedExecutable } from "../aws/microvm-agent/agent.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "executable-attestation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("microVM daemon attestation reads only a bounded exact regular executable", async (t) => {
  const root = await fixture(t);
  const target = join(root, "sample-tool");
  await writeFile(target, "reviewed executable bytes");
  await chmod(target, 0o755);
  const result = readAttestedExecutable("sample-tool", root);
  assert.equal(result.bytes.toString("utf8"), "reviewed executable bytes");
  assert.equal(result.mode, 0o755);

  for (const binary of ["../sample-tool", "sample/tool", "UPPER", "-leading", `sample\ntool`]) {
    assert.throws(() => readAttestedExecutable(binary, root), /invalid binary/);
  }
});

test("microVM daemon attestation rejects non-executable, symlinked, escaped, and oversized targets", async (t) => {
  const root = await fixture(t);
  const nonExecutable = join(root, "nonexec");
  await writeFile(nonExecutable, "bytes");
  await chmod(nonExecutable, 0o644);
  assert.throws(() => readAttestedExecutable("nonexec", root), /invalid executable/);

  const outside = join(root, "outside");
  await writeFile(outside, "outside");
  await chmod(outside, 0o755);
  await symlink(outside, join(root, "linked"));
  assert.throws(() => readAttestedExecutable("linked", root), /invalid executable/);

  const directory = join(root, "directory");
  await mkdir(directory);
  assert.throws(() => readAttestedExecutable("directory", root), /invalid executable/);

  const oversized = join(root, "oversized");
  await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1));
  await chmod(oversized, 0o755);
  assert.throws(() => readAttestedExecutable("oversized", root), /invalid executable/);

  const realRoot = join(root, "real-root");
  await mkdir(realRoot);
  const nested = join(realRoot, "nested");
  await writeFile(nested, "bytes");
  await chmod(nested, 0o755);
  const linkedRoot = join(root, "linked-root");
  await symlink(realRoot, linkedRoot);
  assert.equal(readAttestedExecutable("nested", linkedRoot).bytes.toString("utf8"), "bytes");
});
