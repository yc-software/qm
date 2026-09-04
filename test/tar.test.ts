import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTar, parseTar } from "../src/sandbox/tar.ts";

async function roundTrip(
  entries: Array<{ path: string; data: Buffer }>,
): Promise<Array<{ path: string; data: Buffer }>> {
  return parseTar(await makeTar(entries));
}

test("tar round-trips short paths and binary data", async () => {
  const entries = [
    { path: "notes/a.txt", data: Buffer.from("hello") },
    { path: "dash/app.db", data: Buffer.from([0, 1, 2, 255, 0]) },
  ];
  const out = await roundTrip(entries);
  assert.deepEqual(
    out.map((e) => ({ path: e.path, hex: e.data.toString("hex") })),
    entries.map((e) => ({ path: e.path, hex: e.data.toString("hex") })),
  );
});

test("tar round-trips >100-char paths", async () => {
  const path = `${"deep/".repeat(25)}leaf.txt`;
  assert.ok(path.length > 100);
  const out = await roundTrip([{ path, data: Buffer.from("x") }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.path, path);
});

test("tar round-trips paths that do not fit the ustar 155/100 split", async () => {
  const hex = "ab".repeat(64);
  const paths = [`.npm/_cacache/content-v2/sha512/aa/bb/${hex}`, `${"verylongdirectoryname".repeat(13)}/file.bin`];
  for (const path of paths) assert.ok(Buffer.byteLength(path) > 100);
  assert.ok(Buffer.byteLength(paths[1]!) > 255);

  const entries = paths.map((path, i) => ({ path, data: Buffer.from([i, 7, 9]) }));
  const out = await roundTrip(entries);
  assert.deepEqual(
    out.map((e) => ({ path: e.path, hex: e.data.toString("hex") })),
    entries.map((e) => ({ path: e.path, hex: e.data.toString("hex") })),
  );
});

test("tar with long paths interleaves cleanly with regular entries", async () => {
  const long = `dir/${"f".repeat(200)}`;
  const out = await roundTrip([
    { path: "a.txt", data: Buffer.from("a") },
    { path: long, data: Buffer.from("long") },
    { path: "b.txt", data: Buffer.from("b") },
  ]);
  assert.deepEqual(
    out.map((e) => e.path),
    ["a.txt", long, "b.txt"],
  );
  assert.equal(out[1]!.data.toString("utf8"), "long");
});

test("parseTar of an empty buffer yields no entries", async () => {
  assert.deepEqual(await parseTar(Buffer.alloc(0)), []);
});

test("parseTar rejects a corrupt archive", async () => {
  const tar = await makeTar([{ path: "a.txt", data: Buffer.from("a") }]);
  tar[0] = tar[0]! ^ 0xff;
  await assert.rejects(parseTar(tar));
});

test("parseTar rejects an archive truncated at an entry boundary", async () => {
  const tar = await makeTar([
    { path: "a.txt", data: Buffer.from("aaaa") },
    { path: "b.txt", data: Buffer.from("bbbb") },
  ]);
  await assert.rejects(parseTar(tar.subarray(0, 1024)), /end-of-archive/);
  await assert.rejects(parseTar(tar.subarray(0, 700)));
});

test("parseTar keeps regular files only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tar-codec-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "real.txt"), "real");
  symlinkSync("sub/real.txt", join(dir, "link.txt"));
  execFileSync("tar", ["-cf", "out.tar", "sub", "link.txt"], {
    cwd: dir,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const out = await parseTar(readFileSync(join(dir, "out.tar")));
  assert.deepEqual(
    out.map((e) => ({ path: e.path.replace(/^\.\//, ""), text: e.data.toString("utf8") })),
    [{ path: "sub/real.txt", text: "real" }],
  );
});

test("system tar extracts makeTar output, including PAX long-name entries", async () => {
  const long = `.npm/_cacache/content-v2/sha512/aa/bb/${"cd".repeat(64)}`;
  const entries = [
    { path: "plain.txt", data: Buffer.from("plain") },
    { path: long, data: Buffer.from([9, 8, 7]) },
  ];
  const dir = mkdtempSync(join(tmpdir(), "tar-codec-"));
  writeFileSync(join(dir, "in.tar"), await makeTar(entries));
  execFileSync("tar", ["-xf", "in.tar"], { cwd: dir });
  assert.equal(readFileSync(join(dir, "plain.txt"), "utf8"), "plain");
  assert.equal(readFileSync(join(dir, long)).toString("hex"), "090807");
});
