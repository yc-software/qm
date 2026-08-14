import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";

const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/v1/surface-config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ branding: { accent: "#f0652f", mark: "Y", selfLabel: "QM" } }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "web-ui-branding-test";
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

test.after(() => {
  surface.close();
  core.close();
});

test("cold start: the FIRST shell render already carries accent, mark, and self-label", async () => {
  const r = await fetch(`${base}/`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /--brand-accent:#f0652f/, "accent injected on the first render");
  assert.match(html, /--brand-mark:"Y"/, "mark injected on the first render");
  assert.match(
    html,
    /<meta name="brand-self-label" content="QM"\s*\/?>/,
    "self-label meta injected regardless of template formatting",
  );
});

test("the vite template carries the self-label anchor the server injects into", () => {
  const template = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(template, /<meta name="brand-self-label" content="QM"\s*\/?>/);
});

test("injectBranding rewrites the tab title with the escaped label when a suffix is given", async () => {
  const { injectBranding } = await import("../../chassis/src/branding.ts");
  const shell =
    '<!doctype html><html><head><title>QM · Web</title><meta name="brand-self-label" content="Agent" /></head><body></body></html>';
  const branded = injectBranding(shell, { selfLabel: "straylight" }, { titleSuffix: "· Web" });
  assert.match(branded, /<title>straylight · Web<\/title>/);
  assert.match(injectBranding(shell, {}, { titleSuffix: "· Web" }), /<title>QM · Web<\/title>/);
  const hostile = injectBranding(shell, { selfLabel: "x</title><script>alert(1)</script>" }, { titleSuffix: "· Web" });
  assert.doesNotMatch(hostile, /<script>/i);
  assert.match(hostile, /<title>x&lt;\/title&gt;/);
});

test("brandName() reads the injected self-label and falls back to the product name", async () => {
  const ui = await import("../src/ui.ts");
  const brandName = (ui as { brandName?: () => string }).brandName;
  assert.equal(typeof brandName, "function", "ui.ts exports brandName()");
  const dom = new JSDOM('<head><meta name="brand-self-label" content="Acme"></head>');
  (globalThis as { document?: Document }).document = dom.window.document;
  try {
    assert.equal(brandName!(), "Acme");
  } finally {
    delete (globalThis as { document?: Document }).document;
  }
  assert.equal(brandName!(), "QM");
});
