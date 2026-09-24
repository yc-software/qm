import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "web-ui-favicon-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web");
const distIndex = join(distDir, "index.html");
if (!existsSync(distIndex)) {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    distIndex,
    '<!doctype html><html><head><meta name="brand-self-label" content="Agent" /></head><body></body></html>',
  );
}

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';

test.after(() => {
  surface.close();
  core.close();
});

test("without WEB_UI_FAVICON_SVG the favicon is the emoji and the manifest icon is the stock mark", async () => {
  delete process.env.WEB_UI_FAVICON_SVG;
  const icon = await fetch(`${base}/favicon.svg`);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.match(await icon.text(), /\u{1F3F4}\u{200D}☠️/u);
  const manifest = (await (await fetch(`${base}/manifest.webmanifest`)).json()) as { icons: Array<{ src: string }> };
  assert.equal(manifest.icons[0]?.src, "/brand-mark.svg");
});

test("WEB_UI_FAVICON_SVG is served verbatim and becomes the manifest icon", async () => {
  process.env.WEB_UI_FAVICON_SVG = svg;
  try {
    const icon = await fetch(`${base}/favicon.svg`);
    assert.equal(icon.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await icon.text(), svg);
    const manifest = (await (await fetch(`${base}/manifest.webmanifest`)).json()) as { icons: Array<{ src: string }> };
    assert.equal(manifest.icons[0]?.src, "/favicon.svg");
  } finally {
    delete process.env.WEB_UI_FAVICON_SVG;
  }
});
