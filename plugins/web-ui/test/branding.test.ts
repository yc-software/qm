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
  assert.equal(
    /<title>([\s\S]*?)<\/title>/.exec(hostile)?.[1],
    "x/titlescriptalert(1)/script · Web",
    "markup in the label is stripped, not merely escaped",
  );
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

test("injectBranding cannot be broken out of the style block by a hostile accent or mark", async () => {
  const { injectBranding } = await import("../../chassis/src/branding.ts");
  const shell = "<!doctype html><html><head></head><body></body></html>";

  const hostile = injectBranding(shell, {
    accent: "red;} :root{--x:url(https://evil/a)",
    mark: "</style><img src=https://evil/x>",
  });
  const markValue = /--brand-mark:"([^"]*)"/.exec(hostile)?.[1] ?? "";
  assert.ok(markValue.length > 0, "the mark still renders, sanitized");
  assert.doesNotMatch(markValue, /[<>{}"\\]/, "nothing that could end the CSS string or the style element survives");
  assert.ok(!hostile.includes("--brand-accent"), "an accent that is not a plain hex colour is dropped, not emitted");
  assert.equal(hostile.match(/<\/style>/g)?.length, 1, "exactly one style element — no breakout");

  const good = injectBranding(shell, { accent: "#f0652f", mark: "Y" });
  assert.match(good, /<style>:root\{--brand-accent:#f0652f;--brand-mark:"Y"\}<\/style>/);
});

test("every surface's branding cache sanitizes what the fetcher returned", async () => {
  const { createBrandingCache } = await import("../../chassis/src/branding.ts");
  const cache = createBrandingCache(async () => ({
    accent: "red;} :root{--x:url(https://evil/a)",
    mark: "</style><img src=https://evil/x>",
    selfLabel: "Acme\r\n</title>",
  }));
  assert.deepEqual(await cache.forRender(), { mark: "/s", selfLabel: "Acme/title" });
  assert.deepEqual(cache.current(), { mark: "/s", selfLabel: "Acme/title" });
});

test("sanitizeBranding keeps the mark grammar core stores and strips only what ends a CSS string", async () => {
  const { sanitizeBranding } = await import("../../chassis/src/branding.ts");

  assert.deepEqual(sanitizeBranding({ accent: "  #f0652f  ", mark: "Y", selfLabel: " Acme " }), {
    accent: "#f0652f",
    mark: "Y",
    selfLabel: "Acme",
  });
  assert.deepEqual(sanitizeBranding({ accent: "rgb(1,2,3)", mark: 7, selfLabel: "" }), {});
  assert.equal(sanitizeBranding({ mark: "abcdef" }).mark, "ab", "the mark stays a two-glyph badge");
  for (const mark of [";)", ":)", "A;", "🚀", "Añ"]) {
    assert.equal(sanitizeBranding({ mark }).mark, mark, `a mark core accepts survives here too: ${mark}`);
  }
  assert.equal(sanitizeBranding({ mark: '"\\' }).mark, undefined, "only what could end the CSS string is stripped");
  assert.equal(sanitizeBranding({ selfLabel: "z".repeat(80) }).selfLabel?.length, 40, "the self-label is capped");
  assert.equal(
    sanitizeBranding({ selfLabel: "Acme\r\nSubject: spoofed</title>{x}" }).selfLabel,
    "AcmeSubject: spoofed/titlex",
    "the label reaches sign-in pages and an outbound email subject with no line breaks or markup left in it",
  );
});
