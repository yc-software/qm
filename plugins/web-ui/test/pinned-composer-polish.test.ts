import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("transcript top spacing and prompt gap stay compact at every density", () => {
  const values = [...css.matchAll(/--chat-scroll-pad-top: (\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(values.length >= 3 && values.every((v) => v === 8));
  const prompt = css.match(/\.message-stack \.user-row:not\(:has\(~ \.user-row\)\) \{[^}]*\}/)?.[0] ?? "";
  assert.match(prompt, /padding-top: 8px;/);
  assert.match(prompt, /margin-top: -8px;/);
  assert.match(prompt, /margin-bottom: 12px;/);
});

test("editable background activity is rendered inside the composer surface", () => {
  assert.match(
    chat,
    /composerForm\(agent, html`\$\{glanceTier \? nothing : liveWorkStatus\(agent\)\} \$\{backgroundActivityStrip\(\)\}`\)/,
  );
  assert.match(composer, /<form class="composer-wrap[^]*?\$\{header\}/);
  assert.match(
    css,
    /\.composer-wrap > \.bg-activity \{[^}]*background: color-mix\(in srgb, var\(--secondary\) 40%, var\(--background\)\);/,
  );
});

test("composer status rows share the responsive input font size", () => {
  const sizes = [...css.matchAll(/--composer-font-size: (\d+)px/g)].map((match) => Number(match[1]));
  assert.deepEqual(sizes, [15, 16]);
  for (const selector of [".live-work-line", ".bg-activity-strip", ".composer-input"]) {
    const blocks = css.matchAll(new RegExp(`${selector.replaceAll(".", "\\.")} \\{([^}]+)\\}`, "g"));
    const declarations = [...blocks].flatMap((match) => [...match[1].matchAll(/font-size: ([^;]+);/g)]);
    assert.ok(declarations.length > 0, selector);
    for (const declaration of declarations) assert.match(declaration[1], /^var\(--composer-font-size[,)]/);
  }
});
