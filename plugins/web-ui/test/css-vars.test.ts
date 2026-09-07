import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const shellCss = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const themeCss = readFileSync(
  new URL("../node_modules/@earendil-works/pi-web-ui/dist/app.css", import.meta.url),
  "utf8",
);
const srcDir = new URL("../src/", import.meta.url);
const tsSource = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(new URL(f, srcDir), "utf8"))
  .join("\n");

test("every no-fallback var() in shell.css names a property something defines", () => {
  const defined = new Set<string>();
  for (const m of (shellCss + themeCss).matchAll(/(?:^|[\s;{(])(--[A-Za-z0-9-]+)\s*:/g)) defined.add(m[1]);
  for (const m of tsSource.matchAll(/(--[A-Za-z0-9-]+)/g)) defined.add(m[1]);
  const dead = new Set<string>();
  for (const m of shellCss.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*\)/g)) {
    if (!defined.has(m[1])) dead.add(m[1]);
  }
  assert.deepEqual([...dead], [], "var() references that nothing defines (add the property or a fallback)");
});

test("every drop zone the canvas renders has a positioning rule in shell.css", () => {
  const splitTs = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
  const edges = [...splitTs.matchAll(/zoneTpl\("([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(edges.length >= 5, `expected the canvas drop zones, found ${edges.length}`);
  const missing = edges.filter((e) => !new RegExp(`\\.zone-${e}\\s*\\{`).test(shellCss));
  assert.deepEqual(missing, [], "drop zones rendered with no .zone-<edge> rule (they collapse to 0×0)");
});

test("only the elevated chat surfaces paint a shadow", () => {
  const elevated = [
    ".pinned-strip",
    ".message-stack .user-row:not(:has(~ .user-row)) > .user-bubble",
    ".composer-wrap",
  ];
  const rules = shellCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const painted = [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((rule) =>
    [...rule[2].matchAll(/(box|text)-shadow\s*:\s*([^;}]+)/g)]
      .filter((shadow) => shadow[2].trim() !== "none")
      .map((shadow) => [rule[1].trim(), shadow[1], shadow[2].trim()]),
  );
  assert.deepEqual(
    painted,
    elevated.map((selector) => [selector, "box", "var(--chat-surface-shadow)"]),
    "only the pinned strip, latest prompt bubble, and composer may use the shared elevation shadow",
  );
  const inlineShadows = [...tsSource.matchAll(/(?:box|text)-shadow\s*:\s*([^;}]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => v !== "none");
  assert.deepEqual(inlineShadows, [], "inline styles must not introduce additional shadows");
  assert.doesNotMatch(shellCss + tsSource, /drop-shadow\(/);
});
