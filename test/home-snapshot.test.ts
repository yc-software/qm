import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  chmodSync,
  symlinkSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHomeSnapshotOps,
  createMemorySnapshotStore,
  snapshotDue,
  SnapshotTooLargeError,
  type HomeSnapshotSessionIo,
  type HomeSnapshotStore,
  type SnapshotUpload,
} from "../src/sandbox/home-snapshot.ts";

interface Box {
  root: string;
}

const io: HomeSnapshotSessionIo<Box> = {
  async runCommand(box, script) {
    const r = spawnSync("sh", ["-c", script], { cwd: box.root, encoding: "utf8" });
    return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  async readFileBytes(_box, absPath) {
    return existsSync(absPath) ? new Uint8Array(readFileSync(absPath)) : null;
  },
  async writeFileBytes(_box, absPath, data) {
    writeFileSync(absPath, data);
  },
};

function box(): Box & { home: string; tar: string } {
  const root = mkdtempSync(join(tmpdir(), "home-snap-"));
  const home = join(root, "home");
  mkdirSync(home);
  return { root, home, tar: join(root, "home.tar") };
}

function fill(home: string, name: string, bytes: number, seed = 1): Buffer {
  const data = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (i * seed + 7) % 251;
  mkdirSync(join(home, ...name.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(home, name), data);
  return data;
}

function ops(b: ReturnType<typeof box>, store: HomeSnapshotStore, extra: Record<string, unknown> = {}) {
  return createHomeSnapshotOps<Box>({
    label: "test",
    homeDir: b.home,
    homeTarPath: b.tar,
    prunePaths: ["*/node_modules"],
    store,
    io,
    partBytes: 4096,
    ...extra,
  });
}

function recordingStore(): { store: HomeSnapshotStore; parts: number[]; completed: number; aborted: number } {
  const inner = createMemorySnapshotStore();
  const rec = { store: inner, parts: [] as number[], completed: 0, aborted: 0 };
  rec.store = {
    open: (s) => inner.open(s),
    put: (s, d) => inner.put(s, d),
    createUpload: async (s): Promise<SnapshotUpload> => {
      const upload = await inner.createUpload(s);
      return {
        addPart: async (bytes) => {
          rec.parts.push(bytes.length);
          await upload.addPart(bytes);
        },
        complete: async () => {
          rec.completed++;
          await upload.complete();
        },
        abort: async () => {
          rec.aborted++;
          await upload.abort();
        },
      };
    },
  };
  return rec;
}

test("snapshot streams the home tar as fixed-size parts and hydrates it back byte for byte", async () => {
  const a = box();
  const big = fill(a.home, "project/data.bin", 4096 * 5 + 123);
  fill(a.home, "project/node_modules/dep/index.js", 2048);
  const rec = recordingStore();
  await ops(a, rec.store).snapshotHome("scope", a);

  assert.equal(rec.completed, 1);
  assert.equal(rec.aborted, 0);
  assert.ok(rec.parts.length >= 6, `the tar travelled in ${rec.parts.length} parts, never as one buffer`);
  assert.ok(
    rec.parts.slice(0, -1).every((n) => n === 4096),
    "every part but the last is exactly partBytes",
  );
  assert.equal(existsSync(a.tar), false, "the tar and its parts are cleaned up in the sandbox");

  const b = box();
  assert.equal(await ops(b, rec.store).hydrateHome("scope", b), true);
  assert.ok(Buffer.from(readFileSync(join(b.home, "project/data.bin"))).equals(big));
  assert.equal(existsSync(join(b.home, "project/node_modules")), false, "node_modules was pruned from the snapshot");
  assert.equal(existsSync(b.tar), false);
});

test("a home over the size cap is refused before a single byte is read", async () => {
  const a = box();
  fill(a.home, "huge.bin", 4096 * 8);
  const rec = recordingStore();
  await assert.rejects(
    () => ops(a, rec.store, { maxBytes: 4096 * 4 }).snapshotHome("scope", a),
    (e: unknown) => e instanceof SnapshotTooLargeError && /cap is 16384/.test((e as Error).message),
  );
  assert.equal(rec.parts.length, 0, "no part was uploaded");
  assert.equal(rec.completed, 0);
  assert.equal(existsSync(a.tar), false, "the oversized tar is removed from the sandbox");
  assert.equal(await createMemorySnapshotStore().open("scope"), null);
});

test("a part that comes back the wrong size fails the snapshot and aborts the upload", async () => {
  const a = box();
  fill(a.home, "data.bin", 4096 * 3);
  const rec = recordingStore();
  const lying: HomeSnapshotSessionIo<Box> = {
    ...io,
    readFileBytes: async (b, abs) => {
      const bytes = await io.readFileBytes(b, abs);
      return bytes && abs.endsWith(".1.part") ? bytes.subarray(0, bytes.length - 1) : bytes;
    },
  };
  const snap = createHomeSnapshotOps<Box>({
    label: "test",
    homeDir: a.home,
    homeTarPath: a.tar,
    prunePaths: [],
    store: rec.store,
    io: lying,
    partBytes: 4096,
  });
  await assert.rejects(() => snap.snapshotHome("scope", a), /part 1: got 4095 bytes, expected 4096/);
  assert.equal(rec.aborted, 1);
  assert.equal(rec.completed, 0);
  assert.equal(await rec.store.open("scope"), null, "a failed upload never replaces the stored snapshot");
});

test("hydrate coalesces a stream of small chunks into partBytes writes", async () => {
  const data = Buffer.alloc(4096 * 2 + 10);
  for (let i = 0; i < data.length; i++) data[i] = i % 253;
  const tarBox = box();
  writeFileSync(join(tarBox.home, "f.bin"), data);
  const inner = createMemorySnapshotStore();
  await ops(tarBox, inner).snapshotHome("scope", tarBox);
  const stored = await inner.open("scope");
  assert.ok(stored);
  const whole = Buffer.concat(await Array.fromAsync(stored.parts));
  const dribble: HomeSnapshotStore = {
    ...inner,
    open: async () => ({
      size: whole.length,
      parts: (async function* () {
        for (let off = 0; off < whole.length; off += 700) yield whole.subarray(off, Math.min(off + 700, whole.length));
      })(),
    }),
  };
  const writes: number[] = [];
  const counting: HomeSnapshotSessionIo<Box> = {
    ...io,
    writeFileBytes: async (b, abs, bytes) => {
      writes.push(bytes.length);
      await io.writeFileBytes(b, abs, bytes);
    },
  };
  const b = box();
  const hydrate = createHomeSnapshotOps<Box>({
    label: "test",
    homeDir: b.home,
    homeTarPath: b.tar,
    prunePaths: [],
    store: dribble,
    io: counting,
    partBytes: 4096,
  });
  assert.equal(await hydrate.hydrateHome("scope", b), true);
  assert.ok(
    writes.slice(0, -1).every((n) => n === 4096),
    `writes were ${writes.join(",")}`,
  );
  assert.ok(Buffer.from(readFileSync(join(b.home, "f.bin"))).equals(data));
});

test("the whole snapshot is bounded by one deadline", async () => {
  const a = box();
  fill(a.home, "data.bin", 4096 * 4);
  const slow: HomeSnapshotSessionIo<Box> = {
    ...io,
    readFileBytes: (b, abs) => new Promise((res) => setTimeout(() => res(io.readFileBytes(b, abs)), 40)),
  };
  const rec = recordingStore();
  const snap = createHomeSnapshotOps<Box>({
    label: "test",
    homeDir: a.home,
    homeTarPath: a.tar,
    prunePaths: [],
    store: rec.store,
    io: slow,
    partBytes: 4096,
    timeoutMs: 60,
  });
  await assert.rejects(() => snap.snapshotHome("scope", a), /timed out|exceeded 60ms/);
  assert.equal(rec.completed, 0);
  assert.equal(rec.aborted, 1);
});

test("a missing snapshot hydrates nothing", async () => {
  const b = box();
  assert.equal(await ops(b, createMemorySnapshotStore()).hydrateHome("scope", b), false);
});

test("scratch files that live inside the home never ride the snapshot or survive it", async () => {
  const a = box();
  fill(a.home, "f.bin", 4096 * 2 + 5);
  const inner = createMemorySnapshotStore();
  const at = (b: ReturnType<typeof box>) =>
    createHomeSnapshotOps<Box>({
      label: "test",
      homeDir: b.home,
      homeTarPath: join(b.home, ".qm-home.tar"),
      prunePaths: [],
      store: inner,
      io,
      partBytes: 4096,
    });
  await at(a).snapshotHome("scope", a);
  assert.deepEqual(readdirSync(a.home), ["f.bin"], "tar, listing and parts are all cleaned up");
  const b = box();
  assert.equal(await at(b).hydrateHome("scope", b), true);
  assert.deepEqual(readdirSync(b.home), ["f.bin"], "no scratch file was archived or left behind");
});

test("an unreadable directory does not fail the snapshot", async () => {
  const a = box();
  fill(a.home, "kept.bin", 4096);
  const locked = join(a.home, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "secret"), "x");
  chmodSync(locked, 0);
  const inner = createMemorySnapshotStore();
  try {
    await ops(a, inner).snapshotHome("scope", a);
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.ok(await inner.open("scope"), "the readable files were still saved");
});

test("snapshotDue skips an unused turn only when the stored home is known clean", () => {
  assert.equal(snapshotDue(undefined, undefined, 0), true);
  assert.equal(snapshotDue({ lastSnapshotMs: 100 }, undefined, 0, 101), true);
  assert.equal(snapshotDue({ lastSnapshotMs: 100 }, undefined, 60_000, 101), false, "throttled by the interval");
  assert.equal(snapshotDue({ lastSnapshotMs: 100, homeDirty: false }, { homeUnchanged: true }, 0, 101), false);
  assert.equal(snapshotDue({ lastSnapshotMs: 100, homeDirty: true }, { homeUnchanged: true }, 0, 101), true);
  assert.equal(snapshotDue({ lastSnapshotMs: 100 }, { homeUnchanged: true }, 0, 101), true, "unknown counts as dirty");
  assert.equal(snapshotDue(null, { homeUnchanged: true }, 0), true, "never snapshotted counts as dirty");
});

test("snapshots preserve symlinks and empty directories without following links or archiving pruned contents", async () => {
  const a = box();
  fill(a.home, "project/source", 32);
  fill(a.home, "project/node_modules/excluded", 32);
  mkdirSync(join(a.home, "empty"));
  symlinkSync("project/source", join(a.home, "link"));
  symlinkSync("missing", join(a.home, "dangling"));
  const store = createMemorySnapshotStore();
  await ops(a, store).snapshotHome("scope", a);
  const b = box();
  await ops(b, store).hydrateHome("scope", b);
  assert.equal(readlinkSync(join(b.home, "link")), "project/source");
  assert.equal(readlinkSync(join(b.home, "dangling")), "missing");
  assert.ok(statSync(join(b.home, "empty")).isDirectory());
  assert.equal(existsSync(join(b.home, "project/node_modules")), false);
});

for (const lengthDelta of [-1, 1]) {
  test(`hydrate rejects a stream whose size differs by ${lengthDelta} before touching home files`, async () => {
    const a = box();
    fill(a.home, "existing", 32);
    const store = createMemorySnapshotStore();
    await ops(a, store).snapshotHome("scope", a);
    const mismatched: HomeSnapshotStore = {
      ...store,
      async open(scope) {
        const snapshot = await store.open(scope);
        return snapshot && { ...snapshot, size: snapshot.size + lengthDelta };
      },
    };
    const b = box();
    writeFileSync(join(b.home, "existing"), "keep me");
    await assert.rejects(ops(b, mismatched).hydrateHome("scope", b), /received .* bytes, expected/);
    assert.equal(readFileSync(join(b.home, "existing"), "utf8"), "keep me");
    assert.equal(existsSync(b.tar), false);
  });
}

test("hydrate detects truncated guest writes before extraction", async () => {
  const a = box();
  fill(a.home, "existing", 32);
  const store = createMemorySnapshotStore();
  await ops(a, store).snapshotHome("scope", a);
  const b = box();
  writeFileSync(join(b.home, "existing"), "keep me");
  const truncatedIo = {
    ...io,
    async writeFileBytes(target: Box, path: string, bytes: Uint8Array) {
      await io.writeFileBytes(target, path, bytes.subarray(0, bytes.length - 1));
    },
  };
  await assert.rejects(ops(b, store, { io: truncatedIo }).hydrateHome("scope", b), /wrote .* bytes, expected/);
  assert.equal(readFileSync(join(b.home, "existing"), "utf8"), "keep me");
  assert.equal(existsSync(b.tar), false);
});

test("hydrate validates archive structure before extraction", async () => {
  const store = createMemorySnapshotStore();
  await store.put("scope", Buffer.from("not a tar archive"));
  const b = box();
  writeFileSync(join(b.home, "existing"), "keep me");
  await assert.rejects(ops(b, store).hydrateHome("scope", b), /archive invalid/);
  assert.equal(readFileSync(join(b.home, "existing"), "utf8"), "keep me");
  assert.equal(existsSync(b.tar), false);
});

for (const size of [0, -1, NaN, Infinity, 1.5]) {
  test(`hydrate refuses invalid declared size ${size}`, async () => {
    const store = createMemorySnapshotStore();
    const invalid: HomeSnapshotStore = {
      ...store,
      async open() {
        return {
          size,
          parts: (async function* () {
            yield Buffer.alloc(1);
          })(),
        };
      },
    };
    const b = box();
    await assert.rejects(ops(b, invalid).hydrateHome("scope", b), /invalid snapshot size/);
    assert.equal(existsSync(b.tar), false);
  });
}
