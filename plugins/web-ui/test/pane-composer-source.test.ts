import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("single-pane composers default to the full-width input above a separate toolbar", () => {
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

test("multiview composers use one row regardless of pane dimensions and reset in single view", () => {
  assert.doesNotMatch(css, /@container split-pane \(max-height: 480px\) or \(max-width: 560px\)/);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.includes(".split-canvas:not(.single-pane) .composer-wrap"))
    .map(([rule]) => rule)
    .join("\n");
  const dom = new JSDOM(`<style>${rules}</style><div class="split-canvas">
    <div class="split-pane-content" style="width: 1050px; height: 510px">
      <form class="composer-wrap">
        <div class="attachment-strip"></div>
        <textarea class="composer-input"></textarea>
        <div class="composer-toolbar"></div>
      </form>
    </div>
  </div>`);
  const canvas = dom.window.document.querySelector(".split-canvas")!;
  const style = (selector: string) => dom.window.getComputedStyle(canvas.querySelector(selector)!);
  assert.equal(style(".composer-wrap").display, "grid");
  assert.equal(style(".composer-wrap").gridTemplateColumns, "minmax(0, 1fr) auto");
  assert.equal(style(".attachment-strip").gridColumn, "1 / -1");
  assert.equal(style(".composer-input").gridColumn, "1");
  assert.equal(style(".composer-toolbar").gridColumn, "2");
  assert.equal(style(".composer-input").minHeight, "34px");
  assert.equal(style(".composer-input").maxHeight, "120px");
  canvas.classList.add("single-pane");
  assert.notEqual(style(".composer-wrap").display, "grid");
  assert.notEqual(style(".composer-input").gridColumn, "1");
  assert.notEqual(style(".composer-toolbar").gridColumn, "2");
  dom.window.close();
});

test("narrow panes hide runtime labels, not the accessible picker", () => {
  const narrow = css.slice(css.indexOf("@container split-pane (max-width: 470px)"));
  assert.match(narrow, /\.loadout-button \.menu-label,/);
  assert.match(narrow, /\.loadout-button \.menu-suffix \{\s*display: none;/);
  assert.match(narrow, /\.loadout-button \{[^}]*width: 34px;/);
  assert.doesNotMatch(narrow, /\.loadout-(?:button|control) \{[^}]*display: none;/);
  assert.match(
    readFileSync(new URL("../src/model-picker.ts", import.meta.url), "utf8"),
    /aria-label=\$\{choice \? `Model:/,
  );
});

test("the smallest panes leave text space even with stop controls", () => {
  const minimum = css.slice(css.indexOf("@container split-pane (max-width: 300px)"));
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

test("phone composers keep input and touch controls on one row outside split panes", () => {
  const phone = css.slice(
    css.indexOf("    --composer-font-size: 16px;"),
    css.indexOf("  .live-work-line {", css.indexOf("    --composer-font-size: 16px;")),
  );
  assert.match(phone, /display: grid;[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(phone, /\.composer-wrap > \* \{\s*grid-column: 1 \/ -1;/);
  assert.match(phone, /\.composer-input \{[^}]*grid-column: 1;[^}]*min-width: 0;/);
  assert.match(phone, /\.composer-wrap \.composer-toolbar \{[^}]*grid-column: 2;[^}]*flex-wrap: nowrap;/);
  assert.match(phone, /\.loadout-button \.menu-suffix \{\s*display: none;/);
  assert.match(phone, /\.composer-input::placeholder \{\s*white-space: nowrap;/);
  assert.match(phone, /\.composer-toolbar \.send-btn \{[^}]*width: 44px;[^}]*height: 44px;/);
});
