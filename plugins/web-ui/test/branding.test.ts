import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

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

test("injectBranding refuses any CSS value that could escape the style block it writes", async () => {
  const { injectBranding } = await import("../../chassis/src/branding.ts");
  const shell = "<!doctype html><html><head></head><body></body></html>";
  assert.match(
    injectBranding(shell, { markUrl: "https://cdn.example.com/icon.png" }),
    /--brand-mark-image:url\("https:\/\/cdn\.example\.com\/icon\.png"\)/,
  );
  for (const markUrl of [
    "https://a/</style><script>alert(1)</script>",
    'https://a/");background:url("evil',
    "https://a/x;color:red",
    "https://a/}:root{color:red",
    "http://cdn.example.com/icon.png",
    "javascript:alert(1)",
  ]) {
    assert.equal(injectBranding(shell, { markUrl }), shell, `markUrl rejected: ${markUrl}`);
  }
  assert.equal(injectBranding(shell, { accent: "red;}</style><script>alert(1)</script>" }), shell);
  assert.equal(injectBranding(shell, { mark: '"}</style><script>alert(1)</script>' }), shell);
  assert.match(
    injectBranding(shell, { mark: "A " }),
    /--brand-mark:"A "/,
    "a two-char mark whose second char is a space is legal and still ships",
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

test("the installable-app metadata follows the brand: manifest link, touch icon, home-screen title", async () => {
  const { injectBranding } = await import("../../chassis/src/branding.ts");
  const shell =
    '<html><head><meta name="brand-self-label" content="QM" /><meta name="apple-mobile-web-app-title" content="QM" /></head></html>';
  const branded = injectBranding(shell, { selfLabel: 'Ship "Q"' });
  assert.match(branded, /<meta name="apple-mobile-web-app-title" content="Ship &quot;Q&quot;" \/>/);
  assert.match(injectBranding(shell, {}), /<meta name="apple-mobile-web-app-title" content="QM" \/>/);
});
