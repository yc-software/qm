import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { readWebBundleLayout } from "../cli/src/web-release.ts";
import {
  createLocalWebReleaseStore,
  createWebReleaseReader,
  deployBundledRelease,
  readLivePointer,
  withLocalAssetCache,
  type WebReleaseStore,
} from "../src/web/releases.ts";

function bundle(root: string, name: string, marker: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), `<title>${marker}</title>`);
  writeFileSync(join(dir, "brand-mark.svg"), `<svg>${marker}</svg>`);
  writeFileSync(join(dir, "assets", `app-${name}.js`), marker);
  writeFileSync(join(dir, "assets", `app-${name}.js.gz`), `gz:${marker}`);
  return dir;
}

async function text(stream: Readable): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += String(chunk);
  return out;
}

test("each deploy makes its bundled release live once, and restarts keep a later publish", async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-web-releases-"));
  const store = createLocalWebReleaseStore(join(root, "store"));
  const one = bundle(root, "one", "first");
  const two = bundle(root, "two", "second");
  const idOne = readWebBundleLayout(one).id;
  const idTwo = readWebBundleLayout(two).id;

  assert.deepEqual(await deployBundledRelease(store, one), { id: idOne, uploaded: true, live: idOne });
  assert.deepEqual(await readLivePointer(store), { release: idOne, deployed: idOne });

  await deployBundledRelease(store, two);
  await store.put("live.json", Buffer.from(JSON.stringify({ release: idTwo, deployed: idOne })));
  assert.deepEqual(await deployBundledRelease(store, one), { id: idOne, uploaded: false, live: idTwo });
  assert.deepEqual(await readLivePointer(store), { release: idTwo, deployed: idOne });

  assert.deepEqual(await deployBundledRelease(store, two), { id: idTwo, uploaded: false, live: idTwo });
  assert.deepEqual(await readLivePointer(store), { release: idTwo, deployed: idTwo });
});

test("the reader switches releases within one pointer refresh and keeps old assets", async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-web-releases-"));
  const store = createLocalWebReleaseStore(join(root, "store"));
  const one = bundle(root, "one", "first");
  const two = bundle(root, "two", "second");
  const idTwo = readWebBundleLayout(two).id;
  await deployBundledRelease(store, one);
  await deployBundledRelease(store, two);
  await store.put("live.json", Buffer.from(JSON.stringify({ release: readWebBundleLayout(one).id, deployed: "" })));

  let now = 1_000;
  const reader = createWebReleaseReader(store, { pointerTtlMs: 2_000, now: () => now });
  assert.equal(await reader.document("index.html"), "<title>first</title>");
  await store.put("live.json", Buffer.from(JSON.stringify({ release: idTwo, deployed: "" })));
  now = 3_000;
  assert.equal(await reader.document("index.html"), "<title>first</title>");
  now = 3_001;
  assert.equal(await reader.document("index.html"), "<title>second</title>");

  const brand = await reader.file("brand-mark.svg", false);
  assert.equal(await text(brand!.body), "<svg>second</svg>");
  const oldAsset = await reader.file("assets/app-one.js", true);
  assert.equal(oldAsset!.gzip, true);
  assert.equal(await text(oldAsset!.body), "gz:first");
  const plain = await reader.file("assets/app-one.js", false);
  assert.equal(await text(plain!.body), "first");
  assert.equal(await reader.file("assets/missing.js", true), null);
});

test("a failed pointer refresh keeps serving the last release and reports why", async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-web-releases-"));
  const real = createLocalWebReleaseStore(join(root, "store"));
  await deployBundledRelease(real, bundle(root, "one", "first"));
  let broken = false;
  const store: WebReleaseStore = {
    ...real,
    open: (key) => (broken && key === "live.json" ? Promise.reject(new Error("AccessDenied (403)")) : real.open(key)),
  };
  const lines: string[] = [];
  let now = 1_000;
  const reader = createWebReleaseReader(store, { now: () => now, log: (line) => lines.push(line) });
  assert.equal(await reader.document("index.html"), "<title>first</title>");
  broken = true;
  now = 10_000;
  assert.equal(await reader.document("index.html"), "<title>first</title>");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /still serving [0-9a-f]{64}: AccessDenied \(403\)/);

  const cold = createWebReleaseReader(store, { log: () => assert.fail("a cold reader has nothing to keep serving") });
  await assert.rejects(cold.document("index.html"), /AccessDenied \(403\)/);
  const empty = createWebReleaseReader(createLocalWebReleaseStore(join(root, "empty")));
  await assert.rejects(empty.document("index.html"), /no web UI release is live in .*empty/);
});

test("a core from another deploy line keeps serving its own bundled release", async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-web-releases-"));
  const store = createLocalWebReleaseStore(join(root, "store"));
  const old = bundle(root, "old", "old-core");
  const next = bundle(root, "next", "next-core");
  const oldId = (await deployBundledRelease(store, old)).id;
  const nextId = (await deployBundledRelease(store, next)).id;
  assert.deepEqual(await readLivePointer(store), { release: nextId, deployed: nextId });

  const oldCore = createWebReleaseReader(store, { bundled: () => oldId });
  const nextCore = createWebReleaseReader(store, { bundled: () => nextId });
  assert.equal(await oldCore.document("index.html"), "<title>old-core</title>");
  assert.equal(await nextCore.document("index.html"), "<title>next-core</title>");

  const hotfixId = readWebBundleLayout(bundle(root, "hotfix", "hotfix")).id;
  for (const file of ["index.html", "brand-mark.svg"])
    await store.put(
      `releases/${hotfixId}/${file}`,
      Buffer.from(file === "index.html" ? "<title>hotfix</title>" : "<svg/>"),
    );
  await store.put("live.json", Buffer.from(JSON.stringify({ release: hotfixId, deployed: nextId })));
  const later = createWebReleaseReader(store, { bundled: () => nextId });
  assert.equal(await later.document("index.html"), "<title>hotfix</title>");
  const stale = createWebReleaseReader(store, { bundled: () => oldId });
  assert.equal(await stale.document("index.html"), "<title>old-core</title>");
});

test("assets are fetched from the release store once, then served from the local cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-web-releases-"));
  const real = createLocalWebReleaseStore(join(root, "store"));
  await deployBundledRelease(real, bundle(root, "one", "first"));
  const opened: string[] = [];
  const counted: WebReleaseStore = {
    ...real,
    open: (key) => {
      opened.push(key);
      return real.open(key);
    },
  };
  const cached = withLocalAssetCache(counted, join(root, "cache"));
  for (let i = 0; i < 3; i++) assert.equal(await text((await cached.open("assets/app-one.js"))!), "first");
  assert.equal(await cached.open("assets/missing.js"), null);
  rmSync(join(root, "store", "assets", "app-one.js.gz"));
  for (let i = 0; i < 3; i++) assert.equal(await cached.open("assets/app-one.js.gz"), null);
  assert.deepEqual(opened, ["assets/app-one.js", "assets/missing.js", "assets/app-one.js.gz"]);
  await cached.open("live.json");
  await cached.open("live.json");
  assert.equal(opened.filter((key) => key === "live.json").length, 2);
});
