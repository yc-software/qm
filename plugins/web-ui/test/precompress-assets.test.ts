import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Plugin, ResolvedConfig } from "vite";
import { precompressStaticAssets } from "../vite.config.ts";
import viteConfig from "../vite.config.ts";

type Hook<K extends keyof Plugin> = Extract<Plugin[K], (...args: never[]) => unknown>;

function runBuild(outDir: string, root: string): void {
  const plugin = precompressStaticAssets();
  (plugin.configResolved as Hook<"configResolved">).call(
    {} as never,
    { root, build: { outDir } } as unknown as ResolvedConfig,
  );
  (plugin.closeBundle as Hook<"closeBundle">).call({ info: () => undefined } as never);
}

test("the build writes a gzip sibling for every compressible asset worth compressing", () => {
  const root = mkdtempSync(join(tmpdir(), "precompress-"));
  try {
    const out = join(root, "dist-web");
    mkdirSync(join(out, "assets"), { recursive: true });
    const bundle = `export const x = ${JSON.stringify("a".repeat(60)).repeat(100)};\n`;
    writeFileSync(join(out, "assets", "bundle.js"), bundle);
    writeFileSync(join(out, "assets", "styles.css"), `.a{color:red}\n`.repeat(200));
    writeFileSync(join(out, "assets", "tiny.js"), "export const y = 1;\n");
    writeFileSync(join(out, "assets", "photo.png"), Buffer.alloc(4096, 7));

    runBuild("dist-web", root);

    assert.equal(gunzipSync(readFileSync(join(out, "assets", "bundle.js.gz"))).toString("utf8"), bundle);
    assert.ok(readFileSync(join(out, "assets", "styles.css.gz")).length > 0);
    assert.throws(() => readFileSync(join(out, "assets", "tiny.js.gz")), /ENOENT/, "sub-1KiB files are not worth it");
    assert.throws(() => readFileSync(join(out, "assets", "photo.png.gz")), /ENOENT/, "png is already compressed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the build follows the configured outDir rather than a hardcoded one", () => {
  const root = mkdtempSync(join(tmpdir(), "precompress-outdir-"));
  try {
    const out = join(root, "elsewhere");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "app.js"), `console.log(${JSON.stringify("b".repeat(60))});\n`.repeat(50));
    runBuild("elsewhere", root);
    assert.ok(readFileSync(join(out, "app.js.gz")).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the build config actually registers the precompressor", () => {
  const plugins = (viteConfig as { plugins?: Plugin[] }).plugins ?? [];
  const registered = plugins.find((p) => p.name === "qm-precompress-static-assets");
  assert.ok(registered, "vite.config.ts must register the precompressor or the build ships raw assets");
  assert.equal(registered.apply, "build");
});
