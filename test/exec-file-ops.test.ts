import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createExecFileOps, posixJoin } from "../src/sandbox/exec-file-ops.ts";

const exec = promisify(execFile);

test("combined file cleanup removes only its target and lists remaining files in one command", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "qm-cleanup-'"));
  let calls = 0;
  const ops = createExecFileOps({
    label: "test",
    combineRemoveAndList: true,
    exec: async (_id, script) => {
      calls++;
      const r = await exec("sh", ["-c", script]);
      return { ...r, code: 0 };
    },
    writeInline: async () => {},
  });
  try {
    await mkdir(join(rootDir, "turn/current"), { recursive: true });
    await mkdir(join(rootDir, "turn/keep"), { recursive: true });
    await writeFile(join(rootDir, "turn/current/file"), "remove");
    await writeFile(join(rootDir, "turn/keep/file"), "keep");
    assert.deepEqual(await ops.removeDirAndList!({ id: "test", rootDir }, "turn/current", "turn"), ["turn/keep/file"]);
    assert.equal(calls, 1);
    await assert.rejects(access(join(rootDir, "turn/current")));
    await access(join(rootDir, "turn/keep/file"));
    assert.deepEqual(await ops.removeDirAndList!({ id: "test", rootDir }, "missing", "missing"), []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("combined file cleanup propagates removal and transport failures", async () => {
  const ops = createExecFileOps({
    label: "test",
    combineRemoveAndList: true,
    exec: async () => ({ code: 1, stdout: "", stderr: "permission denied" }),
    writeInline: async () => {},
  });
  await assert.rejects(
    ops.removeDirAndList!({ id: "test", rootDir: "/workspace" }, "turn", "other"),
    /permission denied/,
  );
  const broken = createExecFileOps({
    label: "test",
    combineRemoveAndList: true,
    exec: async () => {
      throw new Error("connection lost");
    },
    writeInline: async () => {},
  });
  await assert.rejects(
    broken.removeDirAndList!({ id: "test", rootDir: "/workspace" }, "turn", "other"),
    /connection lost/,
  );
});

test("combined cleanup is opt-in for provider implementations", () => {
  const ops = createExecFileOps({
    label: "test",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    writeInline: async () => {},
  });
  assert.equal(ops.removeDirAndList, undefined);
});

test("posixJoin rejects parent path segments", () => {
  assert.equal(posixJoin("/root/workspace", "a/b.txt"), "/root/workspace/a/b.txt");
  assert.equal(posixJoin("/root/workspace/", "/a/./b.txt"), "/root/workspace/a/./b.txt");
  assert.throws(() => posixJoin("/root/workspace", "../x"), /must stay inside the workspace/);
  assert.throws(() => posixJoin("/root/workspace", "a/../../x"), /must stay inside the workspace/);
});

test("concurrent imports keep separate archives through extraction and cleanup", { timeout: 10_000 }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "qm-import-'"));
  const handle = { id: "test", rootDir };
  const uploaded = Promise.withResolvers<void>();
  let writes = Promise.resolve();
  let extracts = Promise.resolve();
  let writeCount = 0;
  const makeOps = () =>
    createExecFileOps({
      label: "test",
      writeInline: async (_id, path, data) => {
        writes = writes.then(() => writeFile(path, data));
        await writes;
        if (++writeCount === 2) uploaded.resolve();
        await uploaded.promise;
      },
      exec: async (_id, script) => {
        const result = extracts.then(async () => {
          const r = await exec("sh", ["-c", script]);
          return { ...r, code: 0 };
        });
        extracts = result.then(
          () => {},
          () => {},
        );
        return result;
      },
    });
  const trees = ["first", "second"].map((name) => [
    { path: `${name}/nested/data.bin`, data: Buffer.from([0, 255, name.length]) },
    { path: `${name}/run.sh`, data: Buffer.from(`echo ${name}\n`), mode: 0o755 },
  ]);
  try {
    const results = await Promise.allSettled(trees.map((tree) => makeOps().importFiles(handle, tree)));
    const contents = await Promise.all(
      trees.flat().map(async (entry) => ({
        path: entry.path,
        data: await readFile(join(rootDir, entry.path)).catch(() => null),
      })),
    );
    assert.deepEqual(
      contents,
      trees.flat().map(({ path, data }) => ({ path, data })),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "fulfilled"],
    );
    for (const tree of trees) {
      assert.equal((await stat(join(rootDir, tree[1]!.path))).mode & 0o777, 0o755);
    }
    assert.deepEqual((await readdir(rootDir)).sort(), ["first", "second"]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
