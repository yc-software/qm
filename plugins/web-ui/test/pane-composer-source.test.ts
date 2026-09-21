import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("pane composers default to the full-width input above a separate toolbar", () => {
  assert.doesNotMatch(css, /\.embed-layout/, "panes are elements now, not framed documents");
  const wrap = css.match(/^\.composer-wrap \{[^}]*\}/m)?.[0] ?? "";
  assert.doesNotMatch(wrap, /display: flex;/);
  assert.match(css, /^\.composer-input \{[^}]*width: 100%;[^}]*min-height: 48px;/m);
  assert.match(css, /^\.composer-toolbar \{[^}]*display: flex;[^}]*justify-content: space-between;/m);
  assert.doesNotMatch(css, /\[data-density[^\]]*\] \.composer-(?:wrap|input|toolbar)\s*\{/);
  assert.match(composer, /Math\.max\(ctx\.pane \? 0 : 48, content\)/);
});

test("a multipane composer fills the surface with square edges and no outer gutter", () => {
  const block =
    css.match(
      /\.split-canvas:not\(\.single-pane\) \.split-pane-chat \.custom-chat-shell \.composer-wrap \{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(block, /width: 100%;/);
  assert.match(block, /margin: 0;/);
  assert.match(block, /border-radius: 0;/);
  assert.match(block, /box-shadow: none;/);
});

test("phone touch layout cannot inflate a pane's composer controls", () => {
  assert.match(
    css,
    /\[data-density\] \.composer-toolbar \.icon-btn,\s*\[data-density\] \.composer-toolbar \.menu-button,\s*\[data-density\] \.composer-toolbar \.send-btn \{\s*width: 34px;\s*height: 34px;\s*min-height: 34px;/,
  );
  assert.doesNotMatch(css, /\[data-density[^\]]*\] \.composer-(?:left|right)[^{]*\{/);
});

test("pane settings control is visible without hover", () => {
  assert.doesNotMatch(css, /\.composer-wrap:hover \.settings-control/);
  const block = css.match(/\.settings-control \.menu-button \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(block, /opacity: 0;/);
});

test("only short split panes put the textarea and toolbar on the same grid row", () => {
  assert.match(css, /\.split-pane-content \{\s*container: split-pane \/ size;/);
  const short = css.slice(css.indexOf("@container split-pane (max-height: 480px)"));
  assert.match(short, /\.composer-wrap \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(short, /\.composer-wrap > \* \{\s*grid-column: 1 \/ -1;/);
  assert.match(short, /\.composer-input \{[^}]*grid-column: 1;[^}]*min-height: 34px;[^}]*max-height: 120px;/);
  assert.match(short, /\.composer-toolbar \{[^}]*grid-column: 2;[^}]*flex-wrap: nowrap;/);
  assert.doesNotMatch(short, /\.composer-input \{[^}]*(?<!-)height:/);
  assert.match(short, /\.composer-input::placeholder \{\s*white-space: nowrap;/);
});

test("narrow short panes hide runtime labels, not the accessible picker", () => {
  const narrow = css.slice(css.indexOf("@container split-pane (max-height: 480px) and (max-width: 470px)"));
  assert.match(narrow, /\.loadout-button \.menu-label,/);
  assert.match(narrow, /\.loadout-button \.menu-suffix \{\s*display: none;/);
  assert.match(narrow, /\.loadout-button \{[^}]*width: 34px;/);
  assert.doesNotMatch(narrow, /\.loadout-(?:button|control) \{[^}]*display: none;/);
  assert.match(
    readFileSync(new URL("../src/model-picker.ts", import.meta.url), "utf8"),
    /aria-label=\$\{choice \? `Model:/,
  );
});

test("the smallest short panes leave text space even with stop controls", () => {
  const minimum = css.slice(css.indexOf("@container split-pane (max-height: 480px) and (max-width: 300px)"));
  assert.match(minimum, /\.composer-toolbar \.stop-btn \{\s*width: 28px;\s*height: 28px;\s*min-height: 28px;/);
  assert.match(minimum, /\.composer-attach \{\s*transform: none;/);
});

test("compact overrides stop matching when the canvas returns to one pane", () => {
  const dom = new JSDOM(`<div class="split-canvas single-pane">
    <div class="split-pane-chat">
      <div class="custom-chat-shell in-pane empty-chat">
        <div class="message-stack"><div class="assistant-body"></div><div class="message-bubble"></div></div>
        <div class="chat-cta"></div><div class="composer-wrap"></div>
      </div>
    </div>
  </div>`);
  const canvas = dom.window.document.querySelector(".split-canvas")!;
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const overrides = rules.filter(
    ([, selector, declarations]) =>
      selector.includes(".split-pane-chat") &&
      /(?:font-size: 12px|--composer-font-size: 12px|font-size: 21px)/.test(declarations),
  );
  assert.equal(overrides.length, 4);
  for (const [, selector] of overrides) {
    assert.equal(canvas.querySelector(selector.trim()), null, selector);
  }
  canvas.classList.remove("single-pane");
  for (const [, selector] of overrides) {
    assert.ok(canvas.querySelector(selector.trim()), selector);
  }
  canvas.classList.add("single-pane");
  for (const [, selector] of overrides) {
    assert.equal(canvas.querySelector(selector.trim()), null, selector);
  }
  dom.window.close();
});
