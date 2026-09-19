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

test("composer attachments share the textarea text inset", () => {
  assert.match(shellCss, /--composer-input-pad-inline:\s*8px;/);
  assert.match(shellCss, /\.composer-input \{[\s\S]*?padding:\s*7px var\(--composer-input-pad-inline\) 8px;/);
  assert.match(
    shellCss,
    /\.attachment-strip \{\s*margin-inline:\s*var\(--composer-input-pad-inline\);\s*margin-bottom:\s*4px;\s*\}/,
  );
  assert.match(
    shellCss,
    /\.composer-wrap:has\(\.composer-input:dir\(rtl\)\) \.attachment-strip \{\s*direction:\s*rtl;/,
  );
  assert.match(shellCss, /--composer-input-pad-inline:\s*10px;/);
});

test("composer image previews are 25% larger", () => {
  const preview = shellCss.match(/\.image-preview \{[^}]+\}/)?.[0] ?? "";
  assert.match(preview, /width:\s*70px;\s*height:\s*70px;/);
  assert.doesNotMatch(preview, /border:/);
});

test("sent user images have a passive medium presentation", () => {
  const image = shellCss.match(/\.user-image-attachment \{[^}]+\}/)?.[0] ?? "";
  assert.match(image, /max-width:\s*min\(360px, 100%\);/);
  assert.match(image, /max-height:\s*360px;/);
  assert.match(image, /border-radius:\s*10px;/);
  assert.doesNotMatch(image, /border:|cursor:/);
});

test("two sent user images form a compact side-by-side pair", () => {
  const pair =
    shellCss.match(/\.message-files:has\([\s\S]*?\.user-image-attachment:last-child\s*\) \{[^}]+\}/)?.[0] ?? "";
  assert.match(pair, /display:\s*grid;/);
  assert.match(pair, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(pair, /width:\s*324px;/);
  assert.match(pair, /max-width:\s*100%;/);
  assert.match(pair, /gap:\s*4px;/);
  const images = shellCss.match(/\.message-files:has\([\s\S]*?> \.user-image-attachment \{[^}]+\}/)?.[0] ?? "";
  assert.match(images, /aspect-ratio:\s*1;/);
  assert.match(images, /object-fit:\s*cover;/);
});

test("image remove actions follow the sidebar conversation action styling", () => {
  const imageAction = shellCss.match(/\.image-preview \.chip-x \{[^}]+\}/)?.[0] ?? "";
  assert.match(imageAction, /width:\s*26px;/);
  assert.match(imageAction, /height:\s*26px;/);
  assert.match(imageAction, /border-radius:\s*6px;/);
  assert.match(imageAction, /background:\s*color-mix\(in srgb, var\(--background\) 44%, transparent\);/);
  assert.match(imageAction, /color:\s*var\(--muted-foreground\);/);
  assert.match(imageAction, /opacity 0\.12s ease,/);
  assert.match(imageAction, /background 0\.12s ease,/);
  assert.match(imageAction, /color 0\.12s ease;/);
  assert.match(
    shellCss,
    /\.image-preview \.chip-x:hover,\s*\.image-preview \.chip-x:focus-visible \{\s*background:\s*var\(--secondary\);\s*color:\s*var\(--foreground\);/,
  );
  assert.match(shellCss, /\.image-preview:hover \.chip-x,\s*\.image-preview:focus-within \.chip-x \{\s*opacity:\s*1;/);
  assert.match(shellCss, /@media \(hover: none\) \{\s*\.image-preview \.chip-x \{\s*width:\s*32px;\s*height:\s*32px;/);
});

test("colored session actions keep their row hue at rest and on hover", () => {
  const variables = shellCss.match(/\.session-row\.colored \{[^}]+\}/)?.[0] ?? "";
  assert.match(variables, /--session-action-hover:\s*color-mix\([^;]+var\(--session-color\)/);
  assert.match(variables, /--session-action-foreground:\s*color-mix\([^;]+var\(--session-color\)/);
  assert.match(shellCss, /\.session-row\.colored \.session-menu-btn \{\s*color: var\(--session-action-foreground\);/);
  assert.match(
    shellCss,
    /\.session-row\.colored \.session-menu-btn:hover,[\s\S]*?\.session-row\.colored\.menu-open \.session-menu-btn \{\s*background: var\(--session-action-hover\);\s*color: var\(--session-action-foreground\);/,
  );
});

test("conversation colors use solid fills from the refined spectrum palette on every list surface", () => {
  assert.match(tsSource, /const SESSION_COLORS = \["#f43f5e", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"\]/);
  assert.equal(tsSource.match(/const color = displaySessionColor\(s\.color\);/g)?.length, 2);
  assert.match(tsSource, /const current = displaySessionColor\(s\.color\);/);
  assert.doesNotMatch(tsSource, /#d2664d|#b98a52|#7d884f|#5f8b83|#527d99|#8b5d52/);
  assert.match(shellCss, /conic-gradient\(#f43f5e, #f59e0b, #10b981, #3b82f6, #8b5cf6, #ec4899, #f43f5e\)/);
  for (const rule of [
    shellCss.match(/\.session-row\.colored \.session \{[^}]+\}/)?.[0] ?? "",
    shellCss.match(
      /\.session-row\.colored \.session:hover,\s*\.session-row\.colored\.menu-open \.session \{[^}]+\}/,
    )?.[0] ?? "",
    shellCss.match(/\.session-row\.colored\.active \.session \{[^}]+\}/)?.[0] ?? "",
    shellCss.match(/\.list-row\.chat-row\.colored \{[^}]+\}/)?.[0] ?? "",
    shellCss.match(/\.list-row\.chat-row\.colored:hover \{[^}]+\}/)?.[0] ?? "",
  ]) {
    assert.match(rule, /background:\s*color-mix\(/);
    assert.doesNotMatch(rule, /gradient\(/);
  }
  assert.doesNotMatch(shellCss, /\.session-row\.colored \.session::before/);
});

test("painted sidebar backgrounds align without moving conversation text", () => {
  const extended =
    shellCss.match(
      /\.session-row:is\(\.colored, \.active, \.menu-open, \.selected, \.read-only, :hover\) \.session \{[^}]+\}/,
    )?.[0] ?? "";
  assert.match(extended, /width:\s*calc\(100% \+ 4px\);/);
  assert.match(extended, /margin-left:\s*-4px;/);
  assert.match(extended, /padding-left:\s*15px;/);
  const nested =
    shellCss.match(
      /\.recent-project-children \.session-row:is\(\.colored, \.active, \.menu-open, \.selected, \.read-only, :hover\) \.session,[\s\S]*?\{[^}]+\}/,
    )?.[0] ?? "";
  assert.match(
    nested,
    /\.archived-children \.session-row:is\(\.colored, \.active, \.menu-open, \.selected, \.read-only, :hover\) \.session,/,
  );
  assert.match(
    nested,
    /\.pinned-children \.session-row:is\(\.colored, \.active, \.menu-open, \.selected, \.read-only, :hover\) \.session \{/,
  );
  assert.match(nested, /padding-left:\s*10px;/);
});

test("pinned conversations align with project conversations without a header-to-child gap", () => {
  assert.match(tsSource, /class="pinned-head-glyph"/);
  assert.match(tsSource, /class="pinned-children"/);
  assert.match(shellCss, /\.recent-project \{[\s\S]*?margin:\s*3px 0 5px 4px;/);
  const header = shellCss.match(/\.recents-group\.pinned-head \{[^}]+\}/)?.[0] ?? "";
  assert.match(header, /min-height:\s*30px;/);
  assert.match(header, /margin:\s*3px 0 0 4px;/);
  assert.match(header, /padding:\s*4px 3px 4px 2px;/);
  assert.match(header, /font-size:\s*12\.5px;/);
  assert.match(shellCss, /\.pinned-head-glyph \{[\s\S]*?flex: 0 0 14px;/);
  assert.match(shellCss, /\.pinned-children \{[\s\S]*?margin-left: 13px;/);
  assert.match(shellCss, /\.pinned-children \.session \{\s*padding-left: 6px;/);
});

test("sidebar conversations keep space between their backgrounds and the scrollbar", () => {
  const list = shellCss.match(/\.sidebar \.list \{[^}]+\}/)?.[0] ?? "";
  assert.match(list, /box-sizing:\s*border-box;/);
  assert.match(list, /padding-right:\s*8px;/);
  assert.match(list, /scrollbar-gutter:\s*stable;/);
});

test("every drop zone the canvas renders has a positioning rule in shell.css", () => {
  const splitTs = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
  const edges = [...splitTs.matchAll(/zoneTpl\("([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(edges.length >= 5, `expected the canvas drop zones, found ${edges.length}`);
  const missing = edges.filter((e) => !new RegExp(`\\.zone-${e}\\s*\\{`).test(shellCss));
  assert.deepEqual(missing, [], "drop zones rendered with no .zone-<edge> rule (they collapse to 0×0)");
});

test("chat shadows stay limited to elevated surfaces and subtle activity hover glow", () => {
  const elevated = [".pinned-strip", ".message-stack .user-row.stuck > .user-bubble"];
  const rules = shellCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const painted = [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((rule) =>
    [...rule[2].matchAll(/(box|text)-shadow\s*:\s*([^;}]+)/g)]
      .filter((shadow) => shadow[2].trim() !== "none")
      .map((shadow) => [rule[1].trim(), shadow[1], shadow[2].trim().replace(/\s+/g, " ")]),
  );
  assert.deepEqual(
    painted,
    [
      ...elevated.map((selector) => [selector, "box", "var(--chat-surface-shadow)"]),
      [
        ".work-head:hover,\n.tool-row .tool-summary:hover,\n.thinking-summary:hover",
        "text",
        "0 0 12px color-mix(in srgb, var(--foreground) 12%, transparent)",
      ],
      [".composer-wrap", "box", "0 2px 5px rgb(0 0 0 / 0.05), 0 8px 24px rgb(0 0 0 / 0.06)"],
    ],
    "pinned surfaces and the composer retain their shadows; activity glow appears only on hover",
  );
  const inlineShadows = [...tsSource.matchAll(/(?:box|text)-shadow\s*:\s*([^;}]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => v !== "none");
  assert.deepEqual(inlineShadows, [], "inline styles must not introduce additional shadows");
  assert.doesNotMatch(shellCss + tsSource, /drop-shadow\(/);
});

test("every modal scrim dims through --scrim, which each theme points away from its own text", () => {
  const scrims = [...shellCss.matchAll(/\n\s*\.[^{]*(?:scrim|overlay|backdrop)[^{]*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(scrims.length >= 5, "the scrim rules should still be findable by name");
  for (const rule of scrims) {
    const background = rule.match(/\n\s*background:\s*([^;]+);/)?.[1] ?? "";
    if (!background.includes("transparent") || background === "transparent") continue;
    const name = rule.split("{")[0].trim();
    assert.doesNotMatch(
      background,
      /var\(--foreground\)/,
      `a scrim mixed from --foreground inverts in dark mode, painting white over the page: ${name}`,
    );
    if (background.includes("var(--background)")) continue;
    assert.match(background, /var\(--scrim\)/, `scrim should dim through --scrim: ${name}`);
  }
  const light = shellCss.match(/:root \{[\s\S]*?\n\}/)?.[0] ?? "";
  const dark = shellCss.match(/\n\.dark \{[\s\S]*?\n\}/)?.[0] ?? "";
  for (const [name, block] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    const value = block.match(/--scrim:\s*oklch\(([\d.]+)/)?.[1];
    assert.ok(value, `${name} must define --scrim`);
    assert.ok(Number(value) < 0.2, `${name} --scrim must be dark enough to dim, got L=${value}`);
  }
});
